import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectRetentionCommand,
  PutObjectTaggingCommand,
  UploadPartCopyCommand,
  type CompletedPart,
  type HeadObjectCommandOutput,
  type ObjectIdentifier,
  type StorageClass,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { JobOptions, JobParams, JobType } from '@storage-io/contracts';
import { ProviderError } from '../../common/errors/domain.exception';
import { sanitizeProviderMessage } from '../../common/errors/provider-error.mapper';
import { SettingsService } from '../../settings/settings.service';
import type { StorageContext } from '../storage/storage-context.service';
import type { JobCandidate } from './job-filters';

/**
 * What a job actually does to one object — or, for the two deleting types, to a
 * batch of them.
 *
 * It is separate from the engine because the engine's job is scheduling,
 * checkpointing, pacing and reporting, and none of that should have to be read
 * around eight S3 verbs. The engine calls `applyOne` or `deleteBatch` and cares
 * only whether the object was processed, skipped or failed.
 *
 * Nothing here is written for the object browser's synchronous endpoints: those
 * live in `modules/objects` and answer inside a request. Sharing the code would
 * mean the jobs module importing the objects module, which already imports
 * `JOBS_PORT` — a cycle. The overlap is the S3 call itself, and duplicating one
 * `CopyObjectCommand` is cheaper than a circular module graph.
 */

/** S3 refuses a single-call `CopyObject` above 5 GiB. */
const COPY_MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024;
const COPY_PART_SIZE = 1024 * 1024 * 1024;
const MAX_MULTIPART_PARTS = 10_000;
/** S3's hard limit for one `DeleteObjects` request. */
export const DELETE_BATCH_SIZE = 1000;
const RENAME_ATTEMPTS = 100;
const BYTES_PER_MB = 1024 * 1024;

export type ObjectOutcome = 'processed' | 'skipped';

export interface JobExecution {
  readonly type: JobType;
  readonly source: StorageContext;
  readonly sourceBucket: string;
  readonly target: StorageContext | null;
  readonly targetBucket: string | null;
  readonly targetPrefix: string;
  readonly params: JobParams;
  readonly options: JobOptions;
}

export interface BatchDeleteResult {
  readonly deleted: number;
  readonly failures: readonly { readonly key: string; readonly message: string }[];
}

/** Which types the engine runs a batch at a time rather than object by object. */
export const BATCHED_DELETE_TYPES: readonly JobType[] = ['delete', 'empty-bucket'];

@Injectable()
export class JobActionsService {
  private readonly log = new Logger(JobActionsService.name);

  constructor(private readonly settings: SettingsService) {}

  /**
   * Applies the job's action to one object. Throws on a per-object failure — the
   * engine counts it, logs it and carries on, which is what "nine of ten copied"
   * means in the contract.
   */
  async applyOne(execution: JobExecution, candidate: JobCandidate): Promise<ObjectOutcome> {
    switch (execution.type) {
      case 'copy':
        return this.copy(execution, candidate, false);
      case 'move':
        return this.copy(execution, candidate, true);
      case 'tag':
        return this.tag(execution, candidate);
      case 'storage-class':
        return this.storageClass(execution, candidate);
      case 'retention':
        return this.retention(execution, candidate);
      case 'restore-versions':
        return this.restoreVersion(execution, candidate);
      case 'delete':
      case 'empty-bucket':
        // Both go through `deleteBatch`; the engine never routes them here.
        throw new Error(`Job type "${execution.type}" is executed in batches.`);
    }
  }

  /**
   * Deletes up to `DELETE_BATCH_SIZE` references in one request, the way S3 wants
   * it. Per-object refusals (a retention lock, most often) come back as failures
   * rather than throwing: the other 999 were removed.
   */
  async deleteBatch(
    execution: JobExecution,
    candidates: readonly JobCandidate[],
  ): Promise<BatchDeleteResult> {
    if (candidates.length === 0) return { deleted: 0, failures: [] };

    const objects: ObjectIdentifier[] = candidates.map((candidate) => ({
      Key: candidate.key,
      ...(candidate.versionId === undefined ? {} : { VersionId: candidate.versionId }),
    }));

    const response = await execution.source.client.send(
      new DeleteObjectsCommand({
        Bucket: execution.sourceBucket,
        // Quiet still reports errors; without it a thousand keys come back as a
        // payload nothing reads.
        Delete: { Objects: objects, Quiet: true },
      }),
    );

    const failures = (response.Errors ?? []).map((error) => ({
      key: error.Key ?? '',
      message: sanitizeProviderMessage(error.Message ?? error.Code ?? 'The delete was refused.'),
    }));

    return { deleted: candidates.length - failures.length, failures };
  }

  /* -------------------------------- copy --------------------------- */

  private async copy(
    execution: JobExecution,
    candidate: JobCandidate,
    removeSource: boolean,
  ): Promise<ObjectOutcome> {
    const target = execution.target;
    const targetBucket = execution.targetBucket;
    if (target === null || targetBucket === null) {
      throw new ProviderError('This job has no target bucket, so nothing can be copied.');
    }

    const baseKey = `${execution.targetPrefix}${candidate.key}`;
    const destinationKey = await this.resolveDestinationKey(
      target,
      targetBucket,
      baseKey,
      execution.options.conflict,
    );
    if (destinationKey === null) return 'skipped';

    await this.transfer(execution, candidate, target, targetBucket, destinationKey);

    if (removeSource) {
      await execution.source.client.send(
        new DeleteObjectCommand({
          Bucket: execution.sourceBucket,
          Key: candidate.key,
          ...(candidate.versionId === undefined ? {} : { VersionId: candidate.versionId }),
        }),
      );
    }
    return 'processed';
  }

  private async transfer(
    execution: JobExecution,
    candidate: JobCandidate,
    target: StorageContext,
    targetBucket: string,
    destinationKey: string,
  ): Promise<void> {
    const head = await execution.source.client.send(
      new HeadObjectCommand({
        Bucket: execution.sourceBucket,
        Key: candidate.key,
        ...(candidate.versionId === undefined ? {} : { VersionId: candidate.versionId }),
      }),
    );
    const size = head.ContentLength ?? 0;
    const sameServer = execution.source.row.id === target.row.id;

    if (sameServer && size <= COPY_MULTIPART_THRESHOLD) {
      await target.client.send(
        new CopyObjectCommand({
          Bucket: targetBucket,
          Key: destinationKey,
          CopySource: copySource(execution.sourceBucket, candidate.key, candidate.versionId),
          MetadataDirective: 'COPY',
          TaggingDirective: 'COPY',
        }),
      );
      return;
    }

    if (sameServer) {
      await this.copyLarge(
        target,
        execution.sourceBucket,
        candidate,
        targetBucket,
        destinationKey,
        size,
        head,
      );
      return;
    }

    await this.copyAcrossServers(execution, candidate, target, targetBucket, destinationKey, head);
  }

  /**
   * Server-side multipart copy for an object past S3's single-call limit. The
   * bytes never leave the server — each part is an `UploadPartCopy` with a byte
   * range — which is what makes the extra bookkeeping worth it.
   */
  private async copyLarge(
    target: StorageContext,
    sourceBucket: string,
    candidate: JobCandidate,
    targetBucket: string,
    destinationKey: string,
    size: number,
    head: HeadObjectCommandOutput,
  ): Promise<void> {
    const partCount = Math.max(1, Math.ceil(size / COPY_PART_SIZE));
    if (partCount > MAX_MULTIPART_PARTS) {
      throw new ProviderError(
        `"${candidate.key}" needs ${partCount} parts and S3 allows ${MAX_MULTIPART_PARTS}.`,
      );
    }

    const created = await target.client.send(
      new CreateMultipartUploadCommand({
        Bucket: targetBucket,
        Key: destinationKey,
        ContentType: head.ContentType,
        ...(head.Metadata === undefined ? {} : { Metadata: head.Metadata }),
      }),
    );
    const uploadId = created.UploadId;
    if (uploadId === undefined) throw new ProviderError('The server did not return an upload id.');

    try {
      const parts: CompletedPart[] = [];
      for (let index = 0; index < partCount; index += 1) {
        const start = index * COPY_PART_SIZE;
        const end = Math.min(start + COPY_PART_SIZE, size) - 1;
        const part = await target.client.send(
          new UploadPartCopyCommand({
            Bucket: targetBucket,
            Key: destinationKey,
            UploadId: uploadId,
            PartNumber: index + 1,
            CopySource: copySource(sourceBucket, candidate.key, candidate.versionId),
            CopySourceRange: `bytes=${start}-${end}`,
          }),
        );
        parts.push({ PartNumber: index + 1, ETag: part.CopyPartResult?.ETag });
      }

      await target.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: targetBucket,
          Key: destinationKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (error) {
      await this.abortQuietly(target, targetBucket, destinationKey, uploadId);
      throw error;
    }
  }

  /**
   * Different servers, so the bytes pass through storage-io — streamed, never
   * buffered, with the operator's part size and parallelism from settings.
   */
  private async copyAcrossServers(
    execution: JobExecution,
    candidate: JobCandidate,
    target: StorageContext,
    targetBucket: string,
    destinationKey: string,
    head: HeadObjectCommandOutput,
  ): Promise<void> {
    const object = await execution.source.client.send(
      new GetObjectCommand({
        Bucket: execution.sourceBucket,
        Key: candidate.key,
        ...(candidate.versionId === undefined ? {} : { VersionId: candidate.versionId }),
      }),
    );
    const body = object.Body;
    if (!(body instanceof Readable)) {
      throw new ProviderError('The source server returned an empty body.');
    }

    const transfers = this.settings.getInternal().transfers;
    const tags = await this.readTagString(execution, candidate);

    const upload = new Upload({
      client: target.client,
      params: {
        Bucket: targetBucket,
        Key: destinationKey,
        Body: body,
        ...(head.ContentType === undefined ? {} : { ContentType: head.ContentType }),
        ...(head.Metadata === undefined ? {} : { Metadata: head.Metadata }),
        ...(tags === null ? {} : { Tagging: tags }),
      },
      partSize: transfers.partSizeMb * BYTES_PER_MB,
      queueSize: transfers.parallel,
      leavePartsOnError: false,
    });

    try {
      await upload.done();
    } finally {
      body.destroy();
    }
  }

  /* -------------------------------- tag ---------------------------- */

  /**
   * Merges the job's tags onto the object's own rather than replacing them: an
   * operator adding `retain=2027` to a million objects did not ask to lose
   * whatever else was on them. `PutObjectTagging` replaces the whole set, so the
   * merge has to happen here.
   */
  private async tag(execution: JobExecution, candidate: JobCandidate): Promise<ObjectOutcome> {
    const wanted = execution.params.tags ?? {};
    if (Object.keys(wanted).length === 0) return 'skipped';

    const existing = await this.readTags(execution, candidate);
    const merged = { ...existing, ...wanted };

    await execution.source.client.send(
      new PutObjectTaggingCommand({
        Bucket: execution.sourceBucket,
        Key: candidate.key,
        ...(candidate.versionId === undefined ? {} : { VersionId: candidate.versionId }),
        Tagging: { TagSet: Object.entries(merged).map(([Key, Value]) => ({ Key, Value })) },
      }),
    );
    return 'processed';
  }

  /* --------------------------- storage class ----------------------- */

  /**
   * S3 has no "set the storage class" verb: the change is a copy of the object
   * onto itself with a new class, which is why this is a `CopyObject` rather than
   * a PUT.
   */
  private async storageClass(
    execution: JobExecution,
    candidate: JobCandidate,
  ): Promise<ObjectOutcome> {
    const storageClass = execution.params.storageClass;
    if (storageClass === undefined || storageClass.length === 0) return 'skipped';

    await execution.source.client.send(
      new CopyObjectCommand({
        Bucket: execution.sourceBucket,
        Key: candidate.key,
        CopySource: copySource(execution.sourceBucket, candidate.key, candidate.versionId),
        StorageClass: storageClass as StorageClass,
        MetadataDirective: 'COPY',
        TaggingDirective: 'COPY',
      }),
    );
    return 'processed';
  }

  /* ----------------------------- retention ------------------------- */

  private async retention(
    execution: JobExecution,
    candidate: JobCandidate,
  ): Promise<ObjectOutcome> {
    const retention = execution.params.retention;
    if (retention === undefined) return 'skipped';

    await execution.source.client.send(
      new PutObjectRetentionCommand({
        Bucket: execution.sourceBucket,
        Key: candidate.key,
        ...(candidate.versionId === undefined ? {} : { VersionId: candidate.versionId }),
        Retention: {
          Mode: retention.mode,
          RetainUntilDate: new Date(Date.now() + retention.days * 86_400_000),
        },
      }),
    );
    return 'processed';
  }

  /* -------------------------- restore versions --------------------- */

  /**
   * Undoing a delete on a versioned bucket is removing the delete marker, not
   * copying the previous version forward: S3 then serves the version that was
   * current before, with its own version id and metadata intact.
   *
   * Anything that is not a *current* delete marker is skipped, so a
   * restore-versions job over a bucket where nothing was deleted reports
   * "0 processed, N skipped" rather than rewriting every object.
   */
  private async restoreVersion(
    execution: JobExecution,
    candidate: JobCandidate,
  ): Promise<ObjectOutcome> {
    if (candidate.isDeleteMarker !== true || candidate.isLatest !== true) return 'skipped';
    if (candidate.versionId === undefined) return 'skipped';

    await execution.source.client.send(
      new DeleteObjectCommand({
        Bucket: execution.sourceBucket,
        Key: candidate.key,
        VersionId: candidate.versionId,
      }),
    );
    return 'processed';
  }

  /* ------------------------------ helpers -------------------------- */

  /**
   * `null` means "skip this object" — the `skip` strategy on a key that is
   * already there. `rename` walks `name (2).ext` upwards, which is the same rule
   * the object browser uses.
   */
  private async resolveDestinationKey(
    target: StorageContext,
    bucket: string,
    key: string,
    conflict: JobOptions['conflict'],
  ): Promise<string | null> {
    if (conflict === 'overwrite') return key;

    const exists = await this.exists(target, bucket, key);
    if (!exists) return key;
    if (conflict === 'skip') return null;

    for (let attempt = 2; attempt <= RENAME_ATTEMPTS; attempt += 1) {
      const candidate = withSuffix(key, attempt);
      const taken = await this.exists(target, bucket, candidate);
      if (!taken) return candidate;
    }
    throw new ProviderError(
      `Could not find a free name for "${key}" after ${RENAME_ATTEMPTS} tries.`,
    );
  }

  private async exists(target: StorageContext, bucket: string, key: string): Promise<boolean> {
    try {
      await target.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      // Anything else — a permission problem, a broken connection — is not an
      // answer to "does this exist", and treating it as "no" would overwrite.
      throw error;
    }
  }

  private async readTags(
    execution: JobExecution,
    candidate: JobCandidate,
  ): Promise<Record<string, string>> {
    try {
      const response = await execution.source.client.send(
        new GetObjectTaggingCommand({
          Bucket: execution.sourceBucket,
          Key: candidate.key,
          ...(candidate.versionId === undefined ? {} : { VersionId: candidate.versionId }),
        }),
      );
      const tags: Record<string, string> = {};
      for (const tag of response.TagSet ?? []) {
        if (tag.Key === undefined) continue;
        tags[tag.Key] = tag.Value ?? '';
      }
      return tags;
    } catch {
      // A provider without tagging support answers an error here; a job that only
      // wanted to add tags should still add them.
      return {};
    }
  }

  /** Tags as the `Tagging` header wants them, or null when there are none. */
  private async readTagString(
    execution: JobExecution,
    candidate: JobCandidate,
  ): Promise<string | null> {
    const tags = await this.readTags(execution, candidate);
    const entries = Object.entries(tags);
    if (entries.length === 0) return null;
    return new URLSearchParams(entries).toString();
  }

  private async abortQuietly(
    target: StorageContext,
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await target.client.send(
        new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      );
    } catch (error) {
      // The copy already failed and that is what the job log will say; a failed
      // cleanup only matters to whoever pays for the orphaned parts.
      this.log.warn(
        { bucket, key, err: error instanceof Error ? error.message : String(error) },
        'Could not abort a multipart copy; incomplete parts may remain',
      );
    }
  }
}

/* ------------------------------ helpers --------------------------- */

/** `CopySource` is a URL path, so every segment is encoded — including `/`. */
export function copySource(bucket: string, key: string, versionId?: string): string {
  const path = `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  return versionId === undefined ? path : `${path}?versionId=${encodeURIComponent(versionId)}`;
}

/** `photo.jpg` → `photo (2).jpg`; a key with no extension gets the suffix at the end. */
export function withSuffix(key: string, attempt: number): string {
  const slash = key.lastIndexOf('/');
  const directory = slash === -1 ? '' : key.slice(0, slash + 1);
  const name = slash === -1 ? key : key.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${directory}${name} (${attempt})`;
  return `${directory}${name.slice(0, dot)} (${attempt})${name.slice(dot)}`;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const shape = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (shape.name === 'NotFound' || shape.name === 'NoSuchKey') return true;
  return shape.$metadata?.httpStatusCode === 404;
}
