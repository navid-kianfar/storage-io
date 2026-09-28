import { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  GetObjectLegalHoldCommand,
  GetObjectRetentionCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
  PutObjectRetentionCommand,
  PutObjectTaggingCommand,
  UploadPartCopyCommand,
  type CompletedPart,
  type HeadObjectCommandOutput,
  type ListObjectVersionsCommandOutput,
  type StorageClass,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  type CopyObjectsRequest,
  type CopyObjectsResponse,
  type CreateFolderRequest,
  type DeleteObjectsRequest,
  type DeleteObjectsResponse,
  type ImportObjectFromUrlRequest,
  type ListObjectsQuery,
  type ListObjectsResponse,
  type ObjectError,
  type ObjectItem,
  type ObjectBatchAction,
  type ObjectBatchRequest,
  type ObjectBatchResponse,
  type ObjectMeta,
  type ObjectMetadataBody,
  type ObjectRetentionBody,
  type ObjectTagsBody,
  type ObjectVersion,
  type PresignRequest,
  type PresignResponse,
  type RenameObjectRequest,
  type RestoreVersionRequest,
  type SetObjectStorageClassRequest,
} from '@storage-io/contracts';
import {
  ConflictError,
  DomainException,
  ProviderError,
  ValidationError,
} from '../../common/errors/domain.exception';
import {
  mapProviderError,
  sanitizeProviderMessage,
} from '../../common/errors/provider-error.mapper';
import { SettingsService } from '../../settings/settings.service';
import { InventoryService } from '../inventory/inventory.service';
import { QuotaRepository } from '../quotas/quota.repository';
import { JOBS_PORT, type JobsPort } from '../jobs/jobs.port';
import { StorageContextService, type StorageContext } from '../storage/storage-context.service';
import { ObjectDeleteService, type ObjectVersionRef } from './object-delete.service';
import { ObjectStreamService, SizeLimitedStream, stripQuotes } from './object-stream.service';
import { fetchImportUrl } from './url-import';

const BYTES_PER_MB = 1024 * 1024;

/**
 * Objects deleted in the request rather than handed to a job. Past this the
 * response carries a `Job` instead of a count — which is what the contract's
 * "prefixes and big sets become a job" means.
 */
export const INLINE_DELETE_MAX = 5_000;

/** Objects copied in the request. Copying is far slower per object than deleting. */
export const INLINE_COPY_MAX = 200;

/** S3 refuses a single-call `CopyObject` above 5 GiB; past it, multipart copy. */
export const COPY_MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024;
/** 1 GiB parts: 10 000 parts is S3's limit, so this tops out at ~10 TiB. */
const COPY_PART_SIZE = 1024 * 1024 * 1024;
const MAX_MULTIPART_PARTS = 10_000;

/** Versions walked for `ObjectMeta.versionCount` before reporting unknown. */
const VERSION_COUNT_PAGE_BUDGET = 10;
const LIST_PAGE_MAX = 1000;

/**
 * Objects: listing, metadata, the mutations, and the transfers between buckets and
 * servers. Byte movement itself is `ObjectStreamService`; deletion batching is
 * `ObjectDeleteService`.
 *
 * Three rules shape it:
 *
 * - **Nothing is buffered.** Every body is a stream, end to end, whether it is an
 *   upload, a download, a ZIP or a cross-server copy.
 * - **A set that cannot finish in a request becomes a job.** Deleting a prefix or
 *   copying thousands of objects is recorded and handed over, rather than held open
 *   until a proxy times out and leaves the operator guessing what happened.
 * - **Per-object failures are reported, not thrown.** The contract has an `errors`
 *   array because "nine of ten copied" is the normal outcome when one object is
 *   under a retention lock.
 */
@Injectable()
export class ObjectsService {
  private readonly logger = new Logger(ObjectsService.name);

  constructor(
    private readonly storage: StorageContextService,
    private readonly streams: ObjectStreamService,
    private readonly deleter: ObjectDeleteService,
    private readonly inventory: InventoryService,
    private readonly quotas: QuotaRepository,
    private readonly settings: SettingsService,
    @Inject(JOBS_PORT) private readonly jobs: JobsPort,
  ) {}

  /* -------------------------------- list --------------------------- */

  async list(sid: string, bucket: string, query: ListObjectsQuery): Promise<ListObjectsResponse> {
    const context = this.storage.forServer(sid);
    return query.showVersions
      ? this.listVersions(context, bucket, query)
      : this.listCurrent(context, bucket, query);
  }

  private async listCurrent(
    context: StorageContext,
    bucket: string,
    query: ListObjectsQuery,
  ): Promise<ListObjectsResponse> {
    if (this.needsVersionedListingWorkaround(context, bucket)) {
      return this.listLatestViaVersions(context, bucket, query);
    }

    const response = await context.client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: query.prefix,
        // An empty delimiter means "flat listing"; the SDK omits an empty string.
        ...(query.delimiter.length === 0 ? {} : { Delimiter: query.delimiter }),
        MaxKeys: Math.min(query.limit, LIST_PAGE_MAX),
        ...(query.cursor === undefined
          ? {}
          : { ContinuationToken: decodeCursor(query.cursor).token }),
      }),
    );

    const objects = (response.Contents ?? [])
      .filter((item) => item.Key !== undefined)
      .filter((item) => item.Key !== query.prefix)
      .map((item): ObjectItem => ({
        key: item.Key as string,
        size: item.Size ?? 0,
        lastModified: (item.LastModified ?? new Date(0)).toISOString(),
        etag: stripQuotes(item.ETag ?? ''),
        storageClass: item.StorageClass ?? null,
        versionId: null,
        isLatest: null,
        deleteMarker: false,
      }));

    const prefixes = (response.CommonPrefixes ?? [])
      .filter((entry) => entry.Prefix !== undefined)
      .map((entry) => ({ prefix: entry.Prefix as string }));

    return {
      prefixes: matchingPrefixes(prefixes, query.q),
      objects: matchingObjects(objects, query.q),
      nextCursor:
        response.IsTruncated === true && response.NextContinuationToken !== undefined
          ? encodeCursor({ token: response.NextContinuationToken })
          : null,
    };
  }

  /**
   * A workaround for SeaweedFS, verified against 3.97.
   *
   * On a bucket with versioning enabled, its `ListObjectsV2` reports a nested key
   * with its first path segment doubled — `dir/one.txt` comes back as
   * `dir/dir/one.txt` — and a listing with `Prefix: 'dir/'` returns nothing at all.
   * `ListObjectVersions` on the same bucket is correct, as are `HeadObject` and
   * `GetObject`, so the objects themselves are fine: it is only that listing.
   *
   * Without this, the object browser shows wrong keys at the top level of a
   * versioned SeaweedFS bucket and an empty folder when one is opened.
   *
   * The versioning state comes from the inventory cache rather than a fresh
   * `GetBucketVersioning` per page load. When there is no cached row yet the normal
   * path is used, which is the pre-workaround behaviour rather than a new failure.
   */
  private needsVersionedListingWorkaround(context: StorageContext, bucket: string): boolean {
    if (context.provider !== 'seaweedfs') return false;
    const cached = this.inventory.cached(context.row.id, bucket);
    return cached !== null && cached.versioning !== 'off';
  }

  /**
   * The latest version of each key, presented as a plain listing. Delete markers
   * are dropped: a key whose newest version is a delete marker does not exist.
   */
  private async listLatestViaVersions(
    context: StorageContext,
    bucket: string,
    query: ListObjectsQuery,
  ): Promise<ListObjectsResponse> {
    const versioned = await this.listVersions(context, bucket, query);
    return {
      prefixes: versioned.prefixes,
      objects: versioned.objects
        .filter((object) => object.isLatest === true && !object.deleteMarker)
        .map((object) => ({ ...object, versionId: null, isLatest: null })),
      nextCursor: versioned.nextCursor,
    };
  }

  private async listVersions(
    context: StorageContext,
    bucket: string,
    query: ListObjectsQuery,
  ): Promise<ListObjectsResponse> {
    const cursor = query.cursor === undefined ? {} : decodeCursor(query.cursor);
    const response = await context.client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: query.prefix,
        ...(query.delimiter.length === 0 ? {} : { Delimiter: query.delimiter }),
        MaxKeys: Math.min(query.limit, LIST_PAGE_MAX),
        ...(cursor.keyMarker === undefined ? {} : { KeyMarker: cursor.keyMarker }),
        ...(cursor.versionMarker === undefined ? {} : { VersionIdMarker: cursor.versionMarker }),
      }),
    );

    const versions = (response.Versions ?? [])
      .filter((entry) => entry.Key !== undefined)
      .map((entry): ObjectItem => ({
        key: entry.Key as string,
        size: entry.Size ?? 0,
        lastModified: (entry.LastModified ?? new Date(0)).toISOString(),
        etag: stripQuotes(entry.ETag ?? ''),
        storageClass: entry.StorageClass ?? null,
        versionId: entry.VersionId ?? null,
        isLatest: entry.IsLatest ?? null,
        deleteMarker: false,
      }));

    const markers = (response.DeleteMarkers ?? [])
      .filter((entry) => entry.Key !== undefined)
      .map((entry): ObjectItem => ({
        key: entry.Key as string,
        size: 0,
        lastModified: (entry.LastModified ?? new Date(0)).toISOString(),
        etag: '',
        storageClass: null,
        versionId: entry.VersionId ?? null,
        isLatest: entry.IsLatest ?? null,
        deleteMarker: true,
      }));

    const prefixes = (response.CommonPrefixes ?? [])
      .filter((entry) => entry.Prefix !== undefined)
      .map((entry) => ({ prefix: entry.Prefix as string }));

    return {
      prefixes: matchingPrefixes(prefixes, query.q),
      objects: matchingObjects([...versions, ...markers], query.q),
      nextCursor:
        response.IsTruncated === true
          ? encodeCursor({
              ...(response.NextKeyMarker === undefined
                ? {}
                : { keyMarker: response.NextKeyMarker }),
              ...(response.NextVersionIdMarker === undefined
                ? {}
                : { versionMarker: response.NextVersionIdMarker }),
            })
          : null,
    };
  }

  /* -------------------------------- meta --------------------------- */

  async meta(
    sid: string,
    bucket: string,
    key: string,
    versionId: string | undefined,
  ): Promise<ObjectMeta> {
    const context = this.storage.forServer(sid);
    return this.readMeta(context, bucket, key, versionId);
  }

  private async readMeta(
    context: StorageContext,
    bucket: string,
    key: string,
    versionId: string | undefined,
  ): Promise<ObjectMeta> {
    const head = await context.client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(versionId === undefined ? {} : { VersionId: versionId }),
      }),
    );

    const [tags, retention, legalHold, versionCount] = await Promise.all([
      this.readTags(context, bucket, key, versionId),
      this.readRetention(context, bucket, key, versionId),
      this.readLegalHold(context, bucket, key, versionId),
      this.countVersions(context, bucket, key),
    ]);

    return {
      ...toItem(key, head),
      contentType: head.ContentType ?? null,
      cacheControl: head.CacheControl ?? null,
      contentDisposition: head.ContentDisposition ?? null,
      metadata: { ...(head.Metadata ?? {}) },
      tags,
      retention,
      legalHold,
      versionCount,
    };
  }

  /* ------------------------------- upload -------------------------- */

  /**
   * A raw streamed PUT. The quota check happens before a byte is written where
   * storage-io holds a hard quota the provider is not enforcing — on MinIO the
   * server refuses the write itself, which is the better place for it.
   */
  async upload(
    sid: string,
    bucket: string,
    key: string,
    overwrite: boolean,
    body: Readable,
    headers: UploadHeaders,
  ): Promise<ObjectItem> {
    const context = this.storage.forServer(sid);
    if (!overwrite) await this.streams.assertAbsent(context.client, bucket, key);
    this.assertWithinAppQuota(context, bucket, headers.contentLength ?? 0);

    const item = await this.streams.upload(context.client, {
      bucket,
      key,
      body,
      contentType: headers.contentType,
      metadata: headers.metadata,
      tags: headers.tags,
      storageClass: headers.storageClass,
      contentLength: headers.contentLength,
    });

    this.noteWrite(context, bucket);
    return item;
  }

  /** `PUT …/content` — the in-place text editor, which saves a new version. */
  async putContent(sid: string, bucket: string, key: string, body: Readable): Promise<ObjectItem> {
    const context = this.storage.forServer(sid);
    const existing = await this.headOrNull(context, bucket, key);

    const item = await this.streams.upload(context.client, {
      bucket,
      key,
      body,
      // The editor sends text; keeping the object's own type means editing a
      // `.json` file does not turn it into `text/plain`.
      contentType: existing?.ContentType ?? 'text/plain; charset=utf-8',
      metadata: { ...(existing?.Metadata ?? {}) },
      tags: {},
      storageClass: existing?.StorageClass ?? null,
      contentLength: null,
    });

    this.noteWrite(context, bucket);
    return item;
  }

  /** A folder is a zero-byte key ending in `/` — S3 has no directories. */
  async createFolder(sid: string, bucket: string, request: CreateFolderRequest): Promise<void> {
    const context = this.storage.forServer(sid);
    const prefix = request.prefix.endsWith('/') ? request.prefix : `${request.prefix}/`;

    await context.client.send(
      new PutObjectCommand({ Bucket: bucket, Key: prefix, Body: '', ContentLength: 0 }),
    );
    this.noteWrite(context, bucket);
  }

  /* -------------------------------- delete ------------------------- */

  async remove(
    sid: string,
    bucket: string,
    request: DeleteObjectsRequest,
  ): Promise<DeleteObjectsResponse> {
    const context = this.storage.forServer(sid);

    // A prefix has no known size until it is listed, and listing it to decide
    // would be most of the work; the contract hands prefixes to a job for that
    // reason rather than guessing.
    if (request.prefixes.length > 0) {
      const job = this.jobs.enqueue({
        type: 'delete',
        source: { serverId: context.row.id, bucket, prefix: request.prefixes[0] },
        params: { includeVersions: request.allVersions },
        keys: request.objects.map((ref) => ref.key),
      });
      return { deleted: 0, errors: [], job };
    }

    if (request.objects.length > INLINE_DELETE_MAX) {
      const job = this.jobs.enqueue({
        type: 'delete',
        source: { serverId: context.row.id, bucket },
        params: { includeVersions: request.allVersions },
        keys: request.objects.map((ref) => ref.key),
      });
      return { deleted: 0, errors: [], job };
    }

    const refs = request.allVersions
      ? await this.expandToVersions(context, bucket, request.objects)
      : request.objects.map((ref) => toRef(ref));

    const outcome = await this.deleter.deleteRefs(context.client, bucket, refs);
    this.noteWrite(context, bucket);
    return { deleted: outcome.deleted, errors: [...outcome.errors], job: null };
  }

  /* --------------------------------- copy -------------------------- */

  /**
   * Copy or move, within a bucket, across buckets or across servers.
   *
   * Same server: the provider copies server-side, so the bytes never travel
   * through storage-io. Different servers: the source is streamed straight into
   * the destination upload, one object at a time, so a 200 GB move costs one part
   * of memory and not a temporary file.
   */
  async copy(
    sid: string,
    bucket: string,
    request: CopyObjectsRequest,
  ): Promise<CopyObjectsResponse> {
    const source = this.storage.forServer(sid);
    const destination = this.storage.forServer(request.destServerId);

    if (request.prefixes.length > 0 || request.keys.length > INLINE_COPY_MAX) {
      const job = this.jobs.enqueue({
        type: request.move ? 'move' : 'copy',
        source: {
          serverId: source.row.id,
          bucket,
          ...(request.prefixes.length > 0 ? { prefix: request.prefixes[0] } : {}),
        },
        target: {
          serverId: destination.row.id,
          bucket: request.destBucket,
          prefix: request.destPrefix,
        },
        options: { conflict: request.conflict },
        keys: request.keys,
      });
      return { copied: 0, errors: [], job };
    }

    let copied = 0;
    const errors: ObjectError[] = [];

    for (const key of request.keys) {
      try {
        const destKey = await this.resolveDestinationKey(destination, request, key);
        if (destKey === null) continue; // conflict: skip

        await this.copyOne(source, bucket, key, destination, request.destBucket, destKey);
        if (request.move) {
          await this.deleter.deleteRefs(source.client, bucket, [{ key }]);
        }
        copied += 1;
      } catch (error) {
        // Logged as well as reported: the response carries a sanitised sentence, and
        // an operator looking into why nine of ten objects copied needs the
        // provider's own wording, which only the log may hold.
        this.logger.warn(
          {
            key,
            from: `${source.row.name}/${bucket}`,
            to: `${destination.row.name}/${request.destBucket}`,
            err: error instanceof Error ? error.message : String(error),
          },
          'Object copy failed',
        );
        errors.push({ key, message: objectErrorMessage(error) });
      }
    }

    this.noteWrite(destination, request.destBucket);
    if (request.move) this.noteWrite(source, bucket);
    return { copied, errors, job: null };
  }

  /** Rename is copy-then-delete with metadata and tags carried across. */
  async rename(sid: string, bucket: string, request: RenameObjectRequest): Promise<ObjectItem> {
    if (request.key === request.newKey) {
      throw new ValidationError('The new key is the same as the current one.');
    }

    const context = this.storage.forServer(sid);
    await this.streams.assertAbsent(context.client, bucket, request.newKey);

    await context.client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: request.newKey,
        CopySource: copySource(bucket, request.key),
        // COPY, not REPLACE: a rename must not quietly drop the content type,
        // cache headers or user metadata the object was uploaded with.
        MetadataDirective: 'COPY',
        TaggingDirective: 'COPY',
      }),
    );
    await this.deleter.deleteRefs(context.client, bucket, [{ key: request.key }]);
    this.noteWrite(context, bucket);

    const head = await context.client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: request.newKey }),
    );
    return toItem(request.newKey, head);
  }

  /* ------------------------------- versions ------------------------ */

  async versions(sid: string, bucket: string, key: string): Promise<readonly ObjectVersion[]> {
    const context = this.storage.forServer(sid);
    const response = await context.client.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, MaxKeys: LIST_PAGE_MAX }),
    );

    const versions = (response.Versions ?? [])
      .filter((entry) => entry.Key === key && entry.VersionId !== undefined)
      .map((entry): ObjectVersion => ({
        versionId: entry.VersionId as string,
        lastModified: (entry.LastModified ?? new Date(0)).toISOString(),
        size: entry.Size ?? 0,
        isLatest: entry.IsLatest ?? false,
        deleteMarker: false,
        etag: entry.ETag === undefined ? null : stripQuotes(entry.ETag),
      }));

    const markers = (response.DeleteMarkers ?? [])
      .filter((entry) => entry.Key === key && entry.VersionId !== undefined)
      .map((entry): ObjectVersion => ({
        versionId: entry.VersionId as string,
        lastModified: (entry.LastModified ?? new Date(0)).toISOString(),
        size: 0,
        isLatest: entry.IsLatest ?? false,
        deleteMarker: true,
        etag: null,
      }));

    return [...versions, ...markers].sort((left, right) =>
      right.lastModified.localeCompare(left.lastModified),
    );
  }

  /**
   * Restoring a version copies it over the current one rather than deleting the
   * versions above it: the history stays intact, which is the point of having it.
   *
   * The copy names the same key as its own source, which not every driver accepts:
   *
   * - MinIO and AWS allow it, because `?versionId=` makes the source a different
   *   object. That is the fast path — the bytes never leave the server.
   * - SeaweedFS refuses it ("copy an object to itself"), and refuses the usual
   *   escape of `MetadataDirective: REPLACE` too, because its gateway cannot parse
   *   a `?versionId=` source in that path at all.
   *
   * So the copy is attempted, and a driver that will not do it gets the honest
   * fallback: read that version and write it back. One object's bytes through the
   * API is a fair price for a restore that works everywhere.
   */
  async restoreVersion(
    sid: string,
    bucket: string,
    request: RestoreVersionRequest,
  ): Promise<ObjectItem> {
    const context = this.storage.forServer(sid);
    const source = await context.client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: request.key,
        VersionId: request.versionId,
      }),
    );

    try {
      await context.client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: request.key,
          CopySource: `${copySource(bucket, request.key)}?versionId=${encodeURIComponent(request.versionId)}`,
          MetadataDirective: 'COPY',
          TaggingDirective: 'COPY',
        }),
      );
    } catch (cause) {
      this.logger.debug(
        `Server-side restore of "${request.key}" was refused (${cause instanceof Error ? cause.message : 'unknown error'}); rewriting the version instead.`,
      );
      await this.rewriteVersion(context, bucket, request, source);
    }
    this.noteWrite(context, bucket);

    const head = await context.client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: request.key }),
    );
    return toItem(request.key, head);
  }

  /** Reads one version's bytes and writes them back as the current object. */
  private async rewriteVersion(
    context: StorageContext,
    bucket: string,
    request: RestoreVersionRequest,
    source: HeadObjectCommandOutput,
  ): Promise<void> {
    const object = await context.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: request.key, VersionId: request.versionId }),
    );
    const body = object.Body;
    if (!(body instanceof Readable)) {
      throw new ProviderError('The server returned an empty body for that version.');
    }

    const tags = await this.readTags(context, bucket, request.key, request.versionId);
    try {
      await this.streams.upload(context.client, {
        bucket,
        key: request.key,
        body,
        contentType: source.ContentType ?? null,
        metadata: { ...(source.Metadata ?? {}) },
        tags,
        storageClass: null,
        contentLength: source.ContentLength ?? null,
      });
    } finally {
      body.destroy();
    }
  }

  /* --------------------------------- tags -------------------------- */

  async getTags(
    sid: string,
    bucket: string,
    key: string,
    versionId: string | undefined,
  ): Promise<ObjectTagsBody> {
    const context = this.storage.forServer(sid);
    return { tags: { ...(await this.readTags(context, bucket, key, versionId)) } };
  }

  async setTags(
    sid: string,
    bucket: string,
    key: string,
    versionId: string | undefined,
    body: ObjectTagsBody,
  ): Promise<ObjectTagsBody> {
    const context = this.storage.forServer(sid);
    this.storage.requireCapability(context, 'tagging', 'object tags');

    await context.client.send(
      new PutObjectTaggingCommand({
        Bucket: bucket,
        Key: key,
        ...(versionId === undefined ? {} : { VersionId: versionId }),
        Tagging: { TagSet: Object.entries(body.tags).map(([Key, Value]) => ({ Key, Value })) },
      }),
    );
    return body;
  }

  /* ------------------------------- metadata ------------------------ */

  /**
   * S3 has no "edit headers" call: metadata is replaced by copying the object over
   * itself with `MetadataDirective: REPLACE`. On a versioned bucket that produces a
   * new version, which is the same thing the object's own history would record for
   * any other edit.
   */
  async setMetadata(
    sid: string,
    bucket: string,
    key: string,
    body: ObjectMetadataBody,
  ): Promise<ObjectMeta> {
    const context = this.storage.forServer(sid);
    const head = await context.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

    await context.client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: key,
        CopySource: copySource(bucket, key),
        MetadataDirective: 'REPLACE',
        TaggingDirective: 'COPY',
        ContentType: body.contentType ?? head.ContentType,
        ...(body.cacheControl === null ? {} : { CacheControl: body.cacheControl }),
        ...(body.contentDisposition === null
          ? {}
          : { ContentDisposition: body.contentDisposition }),
        Metadata: { ...body.metadata },
        ...(head.StorageClass === undefined ? {} : { StorageClass: head.StorageClass }),
      }),
    );

    this.noteWrite(context, bucket);
    return this.readMeta(context, bucket, key, undefined);
  }

  async setStorageClass(
    sid: string,
    bucket: string,
    key: string,
    request: SetObjectStorageClassRequest,
  ): Promise<ObjectMeta> {
    const context = this.storage.forServer(sid);
    this.storage.requireCapability(context, 'storageClasses', 'storage classes');

    await context.client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: key,
        CopySource: copySource(bucket, key),
        MetadataDirective: 'COPY',
        TaggingDirective: 'COPY',
        // See object-stream.service.ts: provider-specific class names are valid.
        StorageClass: request.storageClass as StorageClass,
      }),
    );
    return this.readMeta(context, bucket, key, undefined);
  }

  /* ------------------------------ retention ------------------------ */

  async setRetention(
    sid: string,
    bucket: string,
    key: string,
    versionId: string | undefined,
    body: ObjectRetentionBody,
  ): Promise<ObjectMeta> {
    const context = this.storage.forServer(sid);
    this.storage.requireCapability(context, 'objectLock', 'object lock');

    if ('legalHold' in body) {
      await context.client.send(
        new PutObjectLegalHoldCommand({
          Bucket: bucket,
          Key: key,
          ...(versionId === undefined ? {} : { VersionId: versionId }),
          LegalHold: { Status: body.legalHold ? 'ON' : 'OFF' },
        }),
      );
    } else {
      await context.client.send(
        new PutObjectRetentionCommand({
          Bucket: bucket,
          Key: key,
          ...(versionId === undefined ? {} : { VersionId: versionId }),
          Retention: { Mode: body.mode, RetainUntilDate: new Date(body.until) },
        }),
      );
    }

    return this.readMeta(context, bucket, key, versionId);
  }

  /* ------------------------------- presign ------------------------- */

  /**
   * A presigned GET. The expiry bounds come from the contract (60 s to 7 days,
   * which is SigV4's own ceiling) and the URL is signed with the server's stored
   * credentials — so a share link keeps working exactly as long as those do.
   */
  async presign(sid: string, bucket: string, request: PresignRequest): Promise<PresignResponse> {
    const context = this.storage.forServer(sid);

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: request.key,
      ...(request.versionId === undefined ? {} : { VersionId: request.versionId }),
      ...(request.download
        ? { ResponseContentDisposition: `attachment; filename="${asciiFilename(request.key)}"` }
        : {}),
    });

    const url = await getSignedUrl(context.client, command, {
      expiresIn: request.expiresInSeconds,
    });

    return {
      url,
      expiresAt: new Date(Date.now() + request.expiresInSeconds * 1000).toISOString(),
    };
  }

  /* ----------------------------- import URL ------------------------ */

  /**
   * Fetches a URL server-side and streams it into the bucket.
   *
   * This endpoint makes the API issue an outbound request on a caller's
   * instruction, so the destination is checked before and after every redirect
   * (see `url-import.ts`) and the body is passed through a hard size limit — a
   * remote `Content-Length` is a claim, not a fact.
   */
  async importUrl(
    sid: string,
    bucket: string,
    request: ImportObjectFromUrlRequest,
  ): Promise<ObjectItem> {
    const context = this.storage.forServer(sid);
    if (!request.overwrite) await this.streams.assertAbsent(context.client, bucket, request.key);

    const limitBytes = this.settings.getInternal().transfers.importUrlMaxMb * BYTES_PER_MB;
    const fetched = await fetchImportUrl(request.url, limitBytes);
    this.assertWithinAppQuota(context, bucket, fetched.contentLength ?? 0);

    const limiter = new SizeLimitedStream(limitBytes);
    const body = fetched.body.pipe(limiter);

    try {
      const item = await this.streams.upload(context.client, {
        bucket,
        key: request.key,
        body,
        contentType: fetched.contentType,
        metadata: {},
        tags: {},
        storageClass: null,
        contentLength: fetched.contentLength,
      });
      this.noteWrite(context, bucket);
      return item;
    } finally {
      // The upload aborts its own multipart on failure; the source socket is ours
      // to close, and a half-read response left open is a leaked connection.
      fetched.body.destroy();
    }
  }

  /* -------------------------- batch over keys ---------------------- */

  /**
   * One metadata-only action over an explicit selection, applied in the request.
   *
   * Every key is attempted and its failure reported on its own row, like the bulk
   * bucket action: a selection where one object is under a retention lock must still
   * apply to the rest. Nothing here moves object bytes, which is what makes it safe
   * to do inline at all — the storage-class change is a server-side copy in place.
   *
   * Sequential rather than concurrent: this runs while an operator waits, and a
   * thousand parallel requests against one bucket is how the console becomes the
   * reason the storage server is slow.
   */
  async batch(
    sid: string,
    bucket: string,
    request: ObjectBatchRequest,
  ): Promise<ObjectBatchResponse> {
    const context = this.storage.forServer(sid);
    this.requireBatchCapability(context, request.action);

    let updated = 0;
    const errors: ObjectError[] = [];

    for (const key of request.keys) {
      try {
        await this.applyBatchAction(context, bucket, key, request);
        updated += 1;
      } catch (error) {
        this.logger.warn(
          {
            key,
            bucket,
            action: request.action,
            err: error instanceof Error ? error.message : String(error),
          },
          'Batch object action failed',
        );
        errors.push({ key, message: objectErrorMessage(error) });
      }
    }

    if (updated > 0) this.noteWrite(context, bucket);
    return { updated, errors };
  }

  private requireBatchCapability(context: StorageContext, action: ObjectBatchAction): void {
    switch (action) {
      case 'tags':
        this.storage.requireCapability(context, 'tagging', 'object tags');
        return;
      case 'storage-class':
        this.storage.requireCapability(context, 'storageClasses', 'storage classes');
        return;
      case 'retention':
      case 'legal-hold':
        this.storage.requireCapability(context, 'objectLock', 'object lock');
        return;
    }
  }

  private async applyBatchAction(
    context: StorageContext,
    bucket: string,
    key: string,
    request: ObjectBatchRequest,
  ): Promise<void> {
    switch (request.action) {
      case 'tags':
        await this.setTags(context.row.id, bucket, key, undefined, request.payload);
        return;
      case 'storage-class':
        await this.setStorageClass(context.row.id, bucket, key, request.payload);
        return;
      case 'retention':
        await this.setRetention(context.row.id, bucket, key, undefined, request.payload);
        return;
      case 'legal-hold':
        await this.setRetention(context.row.id, bucket, key, undefined, request.payload);
        return;
    }
  }

  /* ------------------------ streaming pass-through ----------------- */

  /** The controller owns the HTTP response, so it needs the context and streams. */
  contextFor(sid: string): StorageContext {
    return this.storage.forServer(sid);
  }

  get stream(): ObjectStreamService {
    return this.streams;
  }

  /* ------------------------------ internals ------------------------ */

  /**
   * Where storage-io holds a `hard` quota the provider is not enforcing, the write
   * has to be refused here or the limit means nothing. Where the quota is native,
   * this does not second-guess the provider: its own accounting is exact and ours
   * is as fresh as the last inventory pass.
   */
  private assertWithinAppQuota(
    context: StorageContext,
    bucket: string,
    incomingBytes: number,
  ): void {
    const quota = this.quotas.find(context.row.id, bucket);
    if (quota === null || quota.mode !== 'hard' || quota.native) return;

    const cached = this.inventory.cached(context.row.id, bucket);
    const used = cached?.sizeBytes ?? 0;
    if (used + incomingBytes <= quota.limitBytes) return;

    throw new ConflictError(
      `"${bucket}" would exceed its ${quota.limitBytes}-byte quota (${used} bytes in use).`,
    );
  }

  /**
   * Marks the bucket as written to, so the list's "last written" column and the
   * size are not a refresher cycle behind the operator's own action. The size
   * itself is left to the refresher: adding up deltas per request drifts, and a
   * wrong number is worse than a slightly old one.
   */
  private noteWrite(context: StorageContext, bucket: string): void {
    this.inventory.patch(context.row.id, bucket, { lastWriteAt: new Date().toISOString() });
  }

  private async expandToVersions(
    context: StorageContext,
    bucket: string,
    refs: readonly { key: string; versionId?: string }[],
  ): Promise<readonly ObjectVersionRef[]> {
    const expanded: ObjectVersionRef[] = [];

    for (const ref of refs) {
      if (ref.versionId !== undefined) {
        expanded.push({ key: ref.key, versionId: ref.versionId });
        continue;
      }
      const versions = await this.versions(context.row.id, bucket, ref.key);
      if (versions.length === 0) {
        expanded.push({ key: ref.key });
        continue;
      }
      for (const version of versions) {
        expanded.push({ key: ref.key, versionId: version.versionId });
      }
    }

    return expanded;
  }

  /** `null` when the conflict policy says to skip this key. */
  private async resolveDestinationKey(
    destination: StorageContext,
    request: CopyObjectsRequest,
    sourceKey: string,
  ): Promise<string | null> {
    const base = `${request.destPrefix}${basename(sourceKey)}`;
    const taken = await this.streams.exists(destination.client, request.destBucket, base);
    if (!taken) return base;

    switch (request.conflict) {
      case 'overwrite':
        return base;
      case 'skip':
        return null;
      case 'rename':
        return this.firstFreeName(destination, request.destBucket, base);
    }
  }

  /** `report.pdf` → `report (1).pdf`, then `(2)`, the way a file manager does. */
  private async firstFreeName(
    destination: StorageContext,
    bucket: string,
    key: string,
  ): Promise<string> {
    const dot = key.lastIndexOf('.');
    const slash = key.lastIndexOf('/');
    const hasExtension = dot > slash + 1;
    const stem = hasExtension ? key.slice(0, dot) : key;
    const extension = hasExtension ? key.slice(dot) : '';

    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
      const candidate = `${stem} (${attempt})${extension}`;
      const taken = await this.streams.exists(destination.client, bucket, candidate);
      if (!taken) return candidate;
    }

    throw new ConflictError(
      `Could not find a free name for "${key}" after ${RENAME_ATTEMPTS} attempts.`,
    );
  }

  private async copyOne(
    source: StorageContext,
    sourceBucket: string,
    sourceKey: string,
    destination: StorageContext,
    destBucket: string,
    destKey: string,
  ): Promise<void> {
    const head = await source.client.send(
      new HeadObjectCommand({ Bucket: sourceBucket, Key: sourceKey }),
    );
    const size = head.ContentLength ?? 0;
    const sameServer = source.row.id === destination.row.id;

    if (sameServer && size <= COPY_MULTIPART_THRESHOLD) {
      await destination.client.send(
        new CopyObjectCommand({
          Bucket: destBucket,
          Key: destKey,
          CopySource: copySource(sourceBucket, sourceKey),
          MetadataDirective: 'COPY',
          TaggingDirective: 'COPY',
        }),
      );
      return;
    }

    if (sameServer) {
      await this.copyLarge(destination, sourceBucket, sourceKey, destBucket, destKey, size, head);
      return;
    }

    await this.copyAcrossServers(
      source,
      sourceBucket,
      sourceKey,
      destination,
      destBucket,
      destKey,
      head,
    );
  }

  /**
   * Server-side multipart copy, for an object above S3's 5 GiB single-call limit.
   * The bytes still never leave the server: each part is a `UploadPartCopy` with a
   * byte range, which is why this is worth the extra bookkeeping over streaming it
   * through storage-io.
   */
  private async copyLarge(
    context: StorageContext,
    sourceBucket: string,
    sourceKey: string,
    destBucket: string,
    destKey: string,
    size: number,
    head: HeadObjectCommandOutput,
  ): Promise<void> {
    const partCount = Math.ceil(size / COPY_PART_SIZE);
    if (partCount > MAX_MULTIPART_PARTS) {
      throw new ConflictError(
        `"${sourceKey}" is too large to copy: it needs ${partCount} parts and S3 allows ${MAX_MULTIPART_PARTS}.`,
      );
    }

    const created = await context.client.send(
      new CreateMultipartUploadCommand({
        Bucket: destBucket,
        Key: destKey,
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
        const part = await context.client.send(
          new UploadPartCopyCommand({
            Bucket: destBucket,
            Key: destKey,
            UploadId: uploadId,
            PartNumber: index + 1,
            CopySource: copySource(sourceBucket, sourceKey),
            CopySourceRange: `bytes=${start}-${end}`,
          }),
        );
        parts.push({ PartNumber: index + 1, ETag: part.CopyPartResult?.ETag });
      }

      await context.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: destBucket,
          Key: destKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (error) {
      await this.abortQuietly(context, destBucket, destKey, uploadId);
      throw error;
    }
  }

  private async copyAcrossServers(
    source: StorageContext,
    sourceBucket: string,
    sourceKey: string,
    destination: StorageContext,
    destBucket: string,
    destKey: string,
    head: HeadObjectCommandOutput,
  ): Promise<void> {
    const object = await source.client.send(
      new GetObjectCommand({ Bucket: sourceBucket, Key: sourceKey }),
    );
    const body = object.Body;
    if (!(body instanceof Readable)) {
      throw new ProviderError('The source server returned an empty body.');
    }

    const tags = await this.readTags(source, sourceBucket, sourceKey, undefined);
    try {
      await this.streams.upload(destination.client, {
        bucket: destBucket,
        key: destKey,
        body,
        contentType: head.ContentType ?? null,
        metadata: { ...(head.Metadata ?? {}) },
        tags,
        storageClass: null,
        contentLength: head.ContentLength ?? null,
      });
    } finally {
      body.destroy();
    }
  }

  private async abortQuietly(
    context: StorageContext,
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await context.client.send(
        new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      );
    } catch (error) {
      // The copy has already failed and that is what the caller will see; a failed
      // cleanup only matters to whoever pays for the orphaned parts, so it is
      // logged rather than raised over the top of the real error.
      this.logger.warn(
        { bucket, key, uploadId, err: error instanceof Error ? error.message : String(error) },
        'Could not abort the multipart copy; incomplete parts may remain',
      );
    }
  }

  private async headOrNull(
    context: StorageContext,
    bucket: string,
    key: string,
  ): Promise<HeadObjectCommandOutput | null> {
    try {
      return await context.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      // A first save from the editor is a new object; that is not an error.
      return null;
    }
  }

  private async readTags(
    context: StorageContext,
    bucket: string,
    key: string,
    versionId: string | undefined,
  ): Promise<Readonly<Record<string, string>>> {
    try {
      const response = await context.client.send(
        new GetObjectTaggingCommand({
          Bucket: bucket,
          Key: key,
          ...(versionId === undefined ? {} : { VersionId: versionId }),
        }),
      );
      const tags: Record<string, string> = {};
      for (const tag of response.TagSet ?? []) {
        if (tag.Key === undefined) continue;
        tags[tag.Key] = tag.Value ?? '';
      }
      return tags;
    } catch {
      // Providers without object tagging answer with an error rather than an
      // empty set, and "no tags" is the correct reading of that.
      return {};
    }
  }

  private async readRetention(
    context: StorageContext,
    bucket: string,
    key: string,
    versionId: string | undefined,
  ): Promise<ObjectMeta['retention']> {
    try {
      const response = await context.client.send(
        new GetObjectRetentionCommand({
          Bucket: bucket,
          Key: key,
          ...(versionId === undefined ? {} : { VersionId: versionId }),
        }),
      );
      const retention = response.Retention;
      if (retention?.Mode === undefined || retention.RetainUntilDate === undefined) return null;
      return { mode: retention.Mode, until: retention.RetainUntilDate.toISOString() };
    } catch {
      // No retention set, or the bucket has no object lock at all.
      return null;
    }
  }

  private async readLegalHold(
    context: StorageContext,
    bucket: string,
    key: string,
    versionId: string | undefined,
  ): Promise<boolean | null> {
    try {
      const response = await context.client.send(
        new GetObjectLegalHoldCommand({
          Bucket: bucket,
          Key: key,
          ...(versionId === undefined ? {} : { VersionId: versionId }),
        }),
      );
      return response.LegalHold?.Status === 'ON';
    } catch {
      // `null`, not `false`: on a bucket without object lock the question has no
      // answer, and the UI shows those two states differently.
      return null;
    }
  }

  /** `null` for a bucket with more versions of this key than the budget allows. */
  private async countVersions(
    context: StorageContext,
    bucket: string,
    key: string,
  ): Promise<number | null> {
    let count = 0;
    let pages = 0;
    let keyMarker: string | undefined = undefined;
    let versionMarker: string | undefined = undefined;

    try {
      do {
        if (pages >= VERSION_COUNT_PAGE_BUDGET) return null;
        // Annotated: the markers travel both into the request and out of the
        // response, which TypeScript reads as a circular inference.
        const response: ListObjectVersionsCommandOutput = await context.client.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: key,
            MaxKeys: LIST_PAGE_MAX,
            ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
            ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }),
          }),
        );
        pages += 1;
        count += (response.Versions ?? []).filter((entry) => entry.Key === key).length;

        if (response.IsTruncated === true) {
          keyMarker = response.NextKeyMarker;
          versionMarker = response.NextVersionIdMarker;
        } else {
          keyMarker = undefined;
          versionMarker = undefined;
        }
      } while (keyMarker !== undefined || versionMarker !== undefined);

      return count;
    } catch {
      // A provider without versioning answers with an error; "unknown" is right.
      return null;
    }
  }
}

/* ------------------------------ helpers --------------------------- */

const RENAME_ATTEMPTS = 100;

export interface UploadHeaders {
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly storageClass: string | null;
}

/**
 * `CopySource` must be URL-encoded but keep its slashes: the first segment is the
 * bucket and the rest is the key, which may itself contain `/`. Encoding the whole
 * string turns a key with a slash into a key with `%2F` in its name.
 */
export function copySource(bucket: string, key: string): string {
  return [bucket, ...key.split('/')].map(encodeURIComponent).join('/');
}

export const basename = (key: string): string => key.split('/').filter(Boolean).pop() ?? key;

const asciiFilename = (key: string): string =>
  basename(key)
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');

function toItem(key: string, head: HeadObjectCommandOutput): ObjectItem {
  return {
    key,
    size: head.ContentLength ?? 0,
    lastModified: (head.LastModified ?? new Date()).toISOString(),
    etag: stripQuotes(head.ETag ?? ''),
    storageClass: head.StorageClass ?? null,
    versionId: head.VersionId ?? null,
    isLatest: true,
    deleteMarker: head.DeleteMarker === true,
  };
}

const toRef = (ref: { key: string; versionId?: string }): ObjectVersionRef =>
  ref.versionId === undefined ? { key: ref.key } : { key: ref.key, versionId: ref.versionId };

/** `q` narrows the page that was fetched; it is not a server-side search. */
function matchingObjects(objects: readonly ObjectItem[], q: string | undefined): ObjectItem[] {
  if (q === undefined || q.length === 0) return [...objects];
  const needle = q.toLowerCase();
  return objects.filter((object) => basename(object.key).toLowerCase().includes(needle));
}

function matchingPrefixes(
  prefixes: readonly { prefix: string }[],
  q: string | undefined,
): { prefix: string }[] {
  if (q === undefined || q.length === 0) return [...prefixes];
  const needle = q.toLowerCase();
  return prefixes.filter((entry) => basename(entry.prefix).toLowerCase().includes(needle));
}

interface Cursor {
  readonly token?: string;
  readonly keyMarker?: string;
  readonly versionMarker?: string;
}

/**
 * The cursor is opaque to the client. It has to carry two markers for a versioned
 * listing, and a client that learned to parse one shape would break the day the
 * other is used.
 */
export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export function decodeCursor(cursor: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return parsed;
  } catch {
    throw new ValidationError('The cursor is not one this API issued.');
  }
}

/**
 * A per-object message for the `errors` array — never a raw provider string.
 *
 * The provider mapper runs before the generic fallback, because an SDK error often
 * carries `message: "UnknownError"` when the response had no body: mapping it gives
 * the row `NOT_FOUND: …` instead of a word that tells the operator nothing.
 */
export function objectErrorMessage(error: unknown): string {
  if (error instanceof DomainException) return error.message;
  const mapped = mapProviderError(error);
  if (mapped !== null) return `${mapped.code}: ${mapped.detail}`;
  if (error instanceof Error) return sanitizeProviderMessage(error.message);
  return 'The operation failed.';
}
