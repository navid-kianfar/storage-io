import { Injectable, Logger } from '@nestjs/common';
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  type ListObjectVersionsCommandOutput,
  type ListObjectsV2CommandOutput,
  type ObjectIdentifier,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectError } from '@storage-io/contracts';
import { sanitizeProviderMessage } from '../../common/errors/provider-error.mapper';

/** S3's hard limit for one `DeleteObjects` request. */
export const DELETE_BATCH_SIZE = 1000;

/** One `ListObjectsV2` / `ListObjectVersions` page. */
const LIST_PAGE_SIZE = 1000;

export interface DeleteOutcome {
  readonly deleted: number;
  readonly errors: readonly ObjectError[];
  /** True when the object budget ran out before the listing ended. */
  readonly truncated: boolean;
}

export interface ObjectVersionRef {
  readonly key: string;
  readonly versionId?: string;
}

/**
 * Deletion, done the way S3 wants it: in batches of a thousand, listing as it
 * goes and never holding the whole key set in memory.
 *
 * Kept apart from `ObjectsService` because two callers need exactly this and
 * nothing else — `POST …/objects/delete` and emptying a bucket — and a second
 * implementation of "delete a prefix" is how one of them ends up forgetting
 * delete markers.
 *
 * Per-object failures are collected rather than thrown: a batch where 998 objects
 * were removed and two were under a retention lock is a partial success, and the
 * contract has an `errors` array to say so. The provider's own wording is
 * sanitised first — an S3 error message carries the endpoint and the full key path.
 */
@Injectable()
export class ObjectDeleteService {
  private readonly logger = new Logger(ObjectDeleteService.name);

  /** Deletes exactly the given references, batching at S3's limit. */
  async deleteRefs(
    client: S3Client,
    bucket: string,
    refs: readonly ObjectVersionRef[],
  ): Promise<DeleteOutcome> {
    let deleted = 0;
    const errors: ObjectError[] = [];

    for (let offset = 0; offset < refs.length; offset += DELETE_BATCH_SIZE) {
      const batch = refs.slice(offset, offset + DELETE_BATCH_SIZE);
      const outcome = await this.sendBatch(client, bucket, batch);
      deleted += outcome.deleted;
      errors.push(...outcome.errors);
    }

    return { deleted, errors, truncated: false };
  }

  /**
   * Empties a prefix (or a whole bucket, with `prefix: ''`), listing and deleting
   * page by page so memory stays flat whatever the object count.
   *
   * `maxObjects` is the caller's budget. When it is exhausted the outcome comes
   * back `truncated`, and it is the caller's decision whether that is an error or
   * a reason to hand the rest to a job — this service does not know which.
   */
  async deletePrefix(
    client: S3Client,
    bucket: string,
    prefix: string,
    includeVersions: boolean,
    maxObjects: number,
  ): Promise<DeleteOutcome> {
    let deleted = 0;
    let seen = 0;
    const errors: ObjectError[] = [];

    for await (const page of this.pages(client, bucket, prefix, includeVersions)) {
      if (page.length === 0) continue;
      if (seen + page.length > maxObjects) {
        return { deleted, errors, truncated: true };
      }
      seen += page.length;

      const outcome = await this.sendBatch(client, bucket, page);
      deleted += outcome.deleted;
      errors.push(...outcome.errors);
    }

    return { deleted, errors, truncated: false };
  }

  /**
   * Every key under a prefix, up to `limit`. Used where the caller needs the keys
   * themselves rather than to delete them — expanding a prefix into a copy set.
   * Beyond `limit` it reports `truncated` instead of growing without bound.
   */
  async listKeys(
    client: S3Client,
    bucket: string,
    prefix: string,
    limit: number,
  ): Promise<{ keys: readonly string[]; truncated: boolean }> {
    const keys: string[] = [];
    let token: string | undefined = undefined;

    do {
      // Annotated because the continuation token is both read into the request and
      // assigned from the response; TypeScript calls that circular otherwise.
      const response: ListObjectsV2CommandOutput = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: LIST_PAGE_SIZE,
          ContinuationToken: token,
        }),
      );

      for (const item of response.Contents ?? []) {
        if (item.Key === undefined) continue;
        if (keys.length >= limit) return { keys, truncated: true };
        keys.push(item.Key);
      }

      token = response.IsTruncated === true ? response.NextContinuationToken : undefined;
    } while (token !== undefined);

    return { keys, truncated: false };
  }

  /* ------------------------------ internals ------------------------ */

  private async sendBatch(
    client: S3Client,
    bucket: string,
    batch: readonly ObjectVersionRef[],
  ): Promise<{ deleted: number; errors: readonly ObjectError[] }> {
    const objects: ObjectIdentifier[] = batch.map((ref) => ({
      Key: ref.key,
      ...(ref.versionId === undefined ? {} : { VersionId: ref.versionId }),
    }));

    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        // `Quiet` still reports errors; without it the response carries a line per
        // deleted object, which for a thousand keys is a payload nobody reads.
        Delete: { Objects: objects, Quiet: true },
      }),
    );

    const errors: ObjectError[] = (response.Errors ?? []).map((error) => ({
      key: error.Key ?? '',
      message: sanitizeProviderMessage(error.Message ?? error.Code ?? 'The delete was refused.'),
    }));

    if (errors.length > 0) {
      // The provider's own wording, which the response cannot carry: an operator
      // looking into why a move left the original behind needs "Object is under
      // legal hold" rather than the sanitised sentence the contract allows.
      this.logger.warn(
        {
          bucket,
          failed: errors.length,
          providerErrors: (response.Errors ?? []).map((error) => ({
            key: error.Key ?? '',
            code: error.Code ?? null,
            message: error.Message ?? null,
          })),
        },
        'Some objects could not be deleted',
      );
    }

    return { deleted: batch.length - errors.length, errors };
  }

  /**
   * Pages of references to delete. Versioned deletion has to walk
   * `ListObjectVersions` and include delete markers: deleting only the current
   * versions of a versioned bucket leaves it full and `DeleteBucket` still fails.
   */
  private async *pages(
    client: S3Client,
    bucket: string,
    prefix: string,
    includeVersions: boolean,
  ): AsyncGenerator<readonly ObjectVersionRef[]> {
    if (!includeVersions) {
      let token: string | undefined = undefined;
      do {
        const response: ListObjectsV2CommandOutput = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: LIST_PAGE_SIZE,
            ContinuationToken: token,
          }),
        );
        yield (response.Contents ?? [])
          .filter((item) => item.Key !== undefined)
          .map((item) => ({ key: item.Key as string }));
        token = response.IsTruncated === true ? response.NextContinuationToken : undefined;
      } while (token !== undefined);
      return;
    }

    let keyMarker: string | undefined = undefined;
    let versionMarker: string | undefined = undefined;
    do {
      const response: ListObjectVersionsCommandOutput = await client.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: LIST_PAGE_SIZE,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
      );

      const refs: ObjectVersionRef[] = [
        ...(response.Versions ?? []),
        ...(response.DeleteMarkers ?? []),
      ]
        .filter((entry) => entry.Key !== undefined)
        .map((entry) => ({
          key: entry.Key as string,
          ...(entry.VersionId === undefined ? {} : { versionId: entry.VersionId }),
        }));

      yield refs;

      if (response.IsTruncated === true) {
        keyMarker = response.NextKeyMarker;
        versionMarker = response.NextVersionIdMarker;
      } else {
        keyMarker = undefined;
        versionMarker = undefined;
      }
    } while (keyMarker !== undefined || versionMarker !== undefined);
  }
}
