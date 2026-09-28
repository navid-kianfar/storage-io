import { Injectable, Logger } from '@nestjs/common';
import {
  GetBucketLocationCommand,
  GetBucketPolicyCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { BucketAccess, BucketVersioning, JsonObject } from '@storage-io/contracts';
import { accessFromPolicy } from '../buckets/policy-presets';

/** One `ListObjectsV2` page. 1000 is the S3 maximum and the cheapest per object. */
export const SCAN_PAGE_SIZE = 1000;

export interface BucketAttributes {
  readonly versioning: BucketVersioning;
  readonly objectLock: boolean;
  readonly access: BucketAccess;
  readonly policy: JsonObject | null;
  readonly tags: Readonly<Record<string, string>>;
  readonly region: string | null;
}

export interface ScanResult {
  readonly sizeBytes: number;
  readonly objects: number;
  readonly lastWriteAt: string | null;
  /** True when the page budget ran out before the bucket ended. */
  readonly truncated: boolean;
  readonly pagesUsed: number;
}

/**
 * The read-only S3 calls that describe a bucket, and the listing scan that counts
 * it when the provider has no usage API.
 *
 * Every configuration call here answers "not configured" by *failing*
 * (`NoSuchBucketPolicy`, `ObjectLockConfigurationNotFoundError`, …), so each one
 * is wrapped: the absence is the answer, not an error to propagate. A real failure
 * — an unreachable server — surfaces through the caller, which is already
 * handling an offline server.
 */
@Injectable()
export class BucketFactsService {
  private readonly logger = new Logger(BucketFactsService.name);

  /**
   * Five calls, issued together rather than in sequence: they are independent and
   * a bucket's attribute refresh is the slowest part of an inventory pass.
   */
  async readAttributes(client: S3Client, bucket: string): Promise<BucketAttributes> {
    const [versioning, objectLock, policy, tags, region] = await Promise.all([
      this.readVersioning(client, bucket),
      this.readObjectLock(client, bucket),
      this.readPolicy(client, bucket),
      this.readTags(client, bucket),
      this.readRegion(client, bucket),
    ]);

    return {
      versioning,
      objectLock,
      access: accessFromPolicy(policy, bucket),
      policy,
      tags,
      region,
    };
  }

  async readVersioning(client: S3Client, bucket: string): Promise<BucketVersioning> {
    return this.optional<BucketVersioning>('versioning', bucket, 'off', async () => {
      const response = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      if (response.Status === 'Enabled') return 'enabled';
      if (response.Status === 'Suspended') return 'suspended';
      return 'off';
    });
  }

  async readObjectLock(client: S3Client, bucket: string): Promise<boolean> {
    return this.optional('objectLock', bucket, false, async () => {
      const response = await client.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
      return response.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled';
    });
  }

  async readPolicy(client: S3Client, bucket: string): Promise<JsonObject | null> {
    return this.optional('policy', bucket, null, async () => {
      const response = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
      if (response.Policy === undefined) return null;
      return parseJsonObject(response.Policy);
    });
  }

  async readTags(client: S3Client, bucket: string): Promise<Readonly<Record<string, string>>> {
    return this.optional('tags', bucket, {}, async () => {
      const response = await client.send(new GetBucketTaggingCommand({ Bucket: bucket }));
      const tags: Record<string, string> = {};
      for (const tag of response.TagSet ?? []) {
        if (tag.Key === undefined) continue;
        tags[tag.Key] = tag.Value ?? '';
      }
      return tags;
    });
  }

  async readRegion(client: S3Client, bucket: string): Promise<string | null> {
    return this.optional('region', bucket, null, async () => {
      const response = await client.send(new GetBucketLocationCommand({ Bucket: bucket }));
      // S3 answers an empty constraint for us-east-1.
      return response.LocationConstraint ?? 'us-east-1';
    });
  }

  /**
   * Counts a bucket by listing it, bounded by a page budget. Size and count are
   * accumulated per page and nothing is retained, so a bucket with a million
   * objects costs a thousand round trips and a constant amount of memory.
   */
  async scan(client: S3Client, bucket: string, pageBudget: number): Promise<ScanResult> {
    let sizeBytes = 0;
    let objects = 0;
    let lastWriteAt: string | null = null;
    let token: string | undefined = undefined;
    let pagesUsed = 0;

    do {
      if (pagesUsed >= pageBudget) {
        return { sizeBytes, objects, lastWriteAt, truncated: true, pagesUsed };
      }

      // Annotated: the token this loop reads is also assigned from the result, and
      // without an explicit output type TypeScript sees that as a circular
      // inference and falls back to `any`.
      const response: ListObjectsV2CommandOutput = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: SCAN_PAGE_SIZE,
          ContinuationToken: token,
        }),
      );
      pagesUsed += 1;

      for (const item of response.Contents ?? []) {
        objects += 1;
        sizeBytes += item.Size ?? 0;
        const modified = item.LastModified?.toISOString() ?? null;
        if (modified !== null && (lastWriteAt === null || modified > lastWriteAt)) {
          lastWriteAt = modified;
        }
      }

      token = response.IsTruncated === true ? response.NextContinuationToken : undefined;
    } while (token !== undefined);

    return { sizeBytes, objects, lastWriteAt, truncated: false, pagesUsed };
  }

  /**
   * Runs a configuration read whose failure means "not set on this bucket".
   *
   * The narrow alternative — enumerating every SDK error name that means absence
   * — has to be revised for each provider that invents another spelling, and a
   * missed name turns a blank CORS list into a failed inventory pass. The failure
   * is logged at debug with the bucket and the capability, so nothing is silent.
   */
  private async optional<T>(
    what: string,
    bucket: string,
    fallback: T,
    read: () => Promise<T>,
  ): Promise<T> {
    try {
      return await read();
    } catch (error) {
      this.logger.debug(
        { bucket, what, err: error instanceof Error ? error.message : String(error) },
        'Bucket configuration is unset or unreadable; using the default',
      );
      return fallback;
    }
  }
}

/* ------------------------------ helpers --------------------------- */

/** A policy the provider stored but we cannot parse is reported as absent. */
export function parseJsonObject(text: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as JsonObject;
  } catch {
    return null;
  }
}
