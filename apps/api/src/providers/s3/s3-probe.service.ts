import { Injectable, Logger } from '@nestjs/common';
import {
  GetBucketLocationCommand,
  GetBucketReplicationCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  ListBucketsCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { CapabilityState } from '@storage-io/contracts';

/**
 * The S3 probes every provider shares. Each answers one question — "does this
 * server understand this API?" — and turns the answer into a `CapabilityState`
 * rather than throwing, because a probe is diagnostic: not supporting versioning
 * is an answer, not an error.
 *
 * `NotImplemented` / `MethodNotAllowed` mean a permanent no. A configuration-shaped
 * error (`NoSuchBucket`, `AccessDenied`) means "cannot tell from here", which is
 * `not_configured`.
 */

export interface ProbeOutcome {
  readonly state: CapabilityState;
  readonly detail: string | null;
}

const SUPPORTED: ProbeOutcome = { state: 'supported', detail: null };

const errorNameOf = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return 'Unknown';
  const shape = error as { name?: unknown; Code?: unknown };
  if (typeof shape.name === 'string') return shape.name;
  if (typeof shape.Code === 'string') return shape.Code;
  return 'Unknown';
};

/** Names that mean the server does not implement the API at all. */
const PERMANENT_NO = new Set(['NotImplemented', 'MethodNotAllowed', 'InvalidRequest']);
/** Names that mean we cannot tell — missing bucket, or no permission to ask. */
const INCONCLUSIVE = new Set([
  'NoSuchBucket',
  'AccessDenied',
  'AccessDeniedException',
  'NoSuchKey',
  'UnauthorizedAccess',
]);

function classify(error: unknown): ProbeOutcome {
  const name = errorNameOf(error);

  // A "not configured on this bucket" answer proves the API exists.
  if (
    name === 'ObjectLockConfigurationNotFoundError' ||
    name === 'ReplicationConfigurationNotFoundError' ||
    name === 'NoSuchLifecycleConfiguration' ||
    name === 'NoSuchCORSConfiguration'
  ) {
    return SUPPORTED;
  }

  if (PERMANENT_NO.has(name)) return { state: 'not_supported', detail: name };
  if (INCONCLUSIVE.has(name)) return { state: 'not_configured', detail: name };
  return { state: 'not_configured', detail: name };
}

@Injectable()
export class S3ProbeService {
  private readonly logger = new Logger(S3ProbeService.name);

  /** Authenticates and counts buckets in one call — the cheapest real proof. */
  async listBuckets(client: S3Client): Promise<readonly string[]> {
    const response = await client.send(new ListBucketsCommand({}));
    return (response.Buckets ?? [])
      .map((bucket) => bucket.Name)
      .filter((name): name is string => typeof name === 'string');
  }

  /** The bucket the capability probes run against: any bucket will do. */
  pickProbeBucket(buckets: readonly string[]): string | null {
    return buckets[0] ?? null;
  }

  async probeVersioning(client: S3Client, bucket: string): Promise<ProbeOutcome> {
    try {
      await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      return SUPPORTED;
    } catch (error) {
      return this.explain('versioning', error);
    }
  }

  async probeObjectLock(client: S3Client, bucket: string): Promise<ProbeOutcome> {
    try {
      await client.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
      return SUPPORTED;
    } catch (error) {
      return this.explain('objectLock', error);
    }
  }

  async probeReplication(client: S3Client, bucket: string): Promise<ProbeOutcome> {
    try {
      await client.send(new GetBucketReplicationCommand({ Bucket: bucket }));
      return SUPPORTED;
    } catch (error) {
      return this.explain('replication', error);
    }
  }

  /** Used by the connection test to report the region the server thinks it is in. */
  async bucketRegion(client: S3Client, bucket: string): Promise<string | null> {
    try {
      const response = await client.send(new GetBucketLocationCommand({ Bucket: bucket }));
      // S3 answers an empty constraint for us-east-1.
      return response.LocationConstraint ?? 'us-east-1';
    } catch {
      return null;
    }
  }

  private explain(capability: string, error: unknown): ProbeOutcome {
    const outcome = classify(error);
    this.logger.debug(
      { capability, name: errorNameOf(error), state: outcome.state },
      'Capability probe',
    );
    return outcome;
  }
}
