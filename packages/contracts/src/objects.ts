import { z } from 'zod';
import { conflictStrategySchema, isoDateTime, itemsOf } from './common.js';
import { objectLockModeSchema } from './buckets.js';
import { jobSchema } from './jobs.js';

export const OBJECT_LIST_LIMIT_DEFAULT = 200;
export const OBJECT_LIST_LIMIT_MAX = 1000;

export const objectKeySchema = z.string().min(1).max(1024);

export const objectItemSchema = z.object({
  key: z.string(),
  size: z.number().min(0),
  lastModified: isoDateTime,
  etag: z.string(),
  storageClass: z.string().nullable(),
  versionId: z.string().nullable(),
  isLatest: z.boolean().nullable(),
  deleteMarker: z.boolean(),
});
export type ObjectItem = z.infer<typeof objectItemSchema>;

export const objectRetentionSchema = z.object({
  mode: objectLockModeSchema,
  until: isoDateTime,
});
export type ObjectRetention = z.infer<typeof objectRetentionSchema>;

export const objectMetaSchema = objectItemSchema.extend({
  contentType: z.string().nullable(),
  cacheControl: z.string().nullable(),
  contentDisposition: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  tags: z.record(z.string(), z.string()),
  retention: objectRetentionSchema.nullable(),
  legalHold: z.boolean().nullable(),
  versionCount: z.number().int().min(0).nullable(),
});
export type ObjectMeta = z.infer<typeof objectMetaSchema>;

export const objectVersionSchema = z.object({
  versionId: z.string(),
  lastModified: isoDateTime,
  size: z.number().min(0),
  isLatest: z.boolean(),
  deleteMarker: z.boolean(),
  etag: z.string().nullable(),
});
export type ObjectVersion = z.infer<typeof objectVersionSchema>;

export const objectVersionListSchema = itemsOf(objectVersionSchema);
export type ObjectVersionList = z.infer<typeof objectVersionListSchema>;

/* ------------------------------ listing --------------------------- */

export const listObjectsQuerySchema = z.object({
  prefix: z.string().max(1024).default(''),
  delimiter: z.string().max(4).default('/'),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(OBJECT_LIST_LIMIT_MAX)
    .default(OBJECT_LIST_LIMIT_DEFAULT),
  q: z.string().max(200).optional(),
  showVersions: z.stringbool().default(false),
});
export type ListObjectsQuery = z.infer<typeof listObjectsQuerySchema>;

export const listObjectsResponseSchema = z.object({
  prefixes: z.array(z.object({ prefix: z.string() })),
  objects: z.array(objectItemSchema),
  nextCursor: z.string().nullable(),
});
export type ListObjectsResponse = z.infer<typeof listObjectsResponseSchema>;

/* --------------------------- single object ------------------------ */

export const objectKeyQuerySchema = z.object({
  key: objectKeySchema,
  versionId: z.string().max(1024).optional(),
});
export type ObjectKeyQuery = z.infer<typeof objectKeyQuerySchema>;

export const downloadObjectQuerySchema = objectKeyQuerySchema.extend({
  inline: z.stringbool().default(false),
});
export type DownloadObjectQuery = z.infer<typeof downloadObjectQuerySchema>;

export const downloadZipRequestSchema = z.object({
  keys: z.array(objectKeySchema),
  prefixes: z.array(z.string().max(1024)),
});
export type DownloadZipRequest = z.infer<typeof downloadZipRequestSchema>;

export const uploadObjectQuerySchema = z.object({
  key: objectKeySchema,
  overwrite: z.stringbool().default(true),
});
export type UploadObjectQuery = z.infer<typeof uploadObjectQuerySchema>;

/** Headers the raw upload endpoint understands, so both sides agree on spelling. */
export const UPLOAD_HEADERS = {
  metaPrefix: 'x-sio-meta-',
  tags: 'x-sio-tags',
  storageClass: 'x-sio-storage-class',
} as const;

export const putObjectContentQuerySchema = z.object({ key: objectKeySchema });
export type PutObjectContentQuery = z.infer<typeof putObjectContentQuerySchema>;

export const createFolderRequestSchema = z.object({ prefix: z.string().min(1).max(1024) });
export type CreateFolderRequest = z.infer<typeof createFolderRequestSchema>;

/* ----------------------------- mutations -------------------------- */

export const objectRefSchema = z.object({
  key: objectKeySchema,
  versionId: z.string().max(1024).optional(),
});
export type ObjectRef = z.infer<typeof objectRefSchema>;

export const deleteObjectsRequestSchema = z.object({
  objects: z.array(objectRefSchema),
  prefixes: z.array(z.string().max(1024)),
  allVersions: z.boolean(),
});
export type DeleteObjectsRequest = z.infer<typeof deleteObjectsRequestSchema>;

export const objectErrorSchema = z.object({ key: z.string(), message: z.string() });
export type ObjectError = z.infer<typeof objectErrorSchema>;

/** Prefixes and large sets are handed to the job engine instead of done inline. */
export const deleteObjectsResponseSchema = z.object({
  deleted: z.number().int().min(0),
  errors: z.array(objectErrorSchema),
  job: jobSchema.nullable(),
});
export type DeleteObjectsResponse = z.infer<typeof deleteObjectsResponseSchema>;

export const copyObjectsRequestSchema = z.object({
  keys: z.array(objectKeySchema),
  prefixes: z.array(z.string().max(1024)),
  destServerId: z.string().min(1),
  destBucket: z.string().min(1),
  destPrefix: z.string().max(1024),
  move: z.boolean(),
  conflict: conflictStrategySchema,
});
export type CopyObjectsRequest = z.infer<typeof copyObjectsRequestSchema>;

export const copyObjectsResponseSchema = z.object({
  copied: z.number().int().min(0),
  errors: z.array(objectErrorSchema),
  job: jobSchema.nullable(),
});
export type CopyObjectsResponse = z.infer<typeof copyObjectsResponseSchema>;

export const renameObjectRequestSchema = z.object({
  key: objectKeySchema,
  newKey: objectKeySchema,
});
export type RenameObjectRequest = z.infer<typeof renameObjectRequestSchema>;

export const restoreVersionRequestSchema = z.object({
  key: objectKeySchema,
  versionId: z.string().min(1),
});
export type RestoreVersionRequest = z.infer<typeof restoreVersionRequestSchema>;

export const objectTagsBodySchema = z.object({ tags: z.record(z.string(), z.string()) });
export type ObjectTagsBody = z.infer<typeof objectTagsBodySchema>;

export const objectMetadataBodySchema = z.object({
  contentType: z.string().max(255).nullable(),
  cacheControl: z.string().max(255).nullable(),
  contentDisposition: z.string().max(255).nullable(),
  metadata: z.record(z.string(), z.string()),
});
export type ObjectMetadataBody = z.infer<typeof objectMetadataBodySchema>;

export const objectRetentionBodySchema = z.union([
  z.object({ mode: objectLockModeSchema, until: isoDateTime }),
  z.object({ legalHold: z.boolean() }),
]);
export type ObjectRetentionBody = z.infer<typeof objectRetentionBodySchema>;

export const PRESIGN_MIN_SECONDS = 60;
export const PRESIGN_MAX_SECONDS = 604800;

export const presignRequestSchema = z.object({
  key: objectKeySchema,
  versionId: z.string().max(1024).optional(),
  expiresInSeconds: z.number().int().min(PRESIGN_MIN_SECONDS).max(PRESIGN_MAX_SECONDS),
  download: z.boolean(),
});
export type PresignRequest = z.infer<typeof presignRequestSchema>;

export const presignResponseSchema = z.object({ url: z.string(), expiresAt: isoDateTime });
export type PresignResponse = z.infer<typeof presignResponseSchema>;

/* ------------------------- import from URL ------------------------ */

/**
 * The API fetches the URL server-side and streams it into the bucket; the size
 * ceiling is `Settings.transfers.importUrlMaxMb`.
 */
export const importObjectFromUrlRequestSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  key: objectKeySchema,
  overwrite: z.boolean(),
});
export type ImportObjectFromUrlRequest = z.infer<typeof importObjectFromUrlRequestSchema>;

export const setObjectStorageClassRequestSchema = z.object({
  storageClass: z.string().min(1).max(64),
});
export type SetObjectStorageClassRequest = z.infer<typeof setObjectStorageClassRequestSchema>;

/* ------------------------- batch over a selection ----------------- */

/**
 * One metadata-only action applied to an explicit selection, in the request.
 *
 * Bounded at 1000 keys because that is where "the operator is waiting for this"
 * stops being true; a larger set is a job. The actions are deliberately the cheap
 * ones — nothing here moves object bytes.
 */
export const OBJECT_BATCH_MAX_KEYS = 1000;

export const OBJECT_BATCH_ACTIONS = ['tags', 'storage-class', 'retention', 'legal-hold'] as const;
export const objectBatchActionSchema = z.enum(OBJECT_BATCH_ACTIONS);
export type ObjectBatchAction = z.infer<typeof objectBatchActionSchema>;

export const objectRetentionRuleSchema = z.object({
  mode: objectLockModeSchema,
  until: isoDateTime,
});
export type ObjectRetentionRule = z.infer<typeof objectRetentionRuleSchema>;

export const objectLegalHoldSchema = z.object({ legalHold: z.boolean() });
export type ObjectLegalHold = z.infer<typeof objectLegalHoldSchema>;

const batchKeys = {
  keys: z.array(objectKeySchema).min(1).max(OBJECT_BATCH_MAX_KEYS),
};

/** `payload` is discriminated by `action`, so a tag set cannot reach the lock path. */
export const objectBatchRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...batchKeys, action: z.literal('tags'), payload: objectTagsBodySchema }),
  z.object({
    ...batchKeys,
    action: z.literal('storage-class'),
    payload: setObjectStorageClassRequestSchema,
  }),
  z.object({ ...batchKeys, action: z.literal('retention'), payload: objectRetentionRuleSchema }),
  z.object({ ...batchKeys, action: z.literal('legal-hold'), payload: objectLegalHoldSchema }),
]);
export type ObjectBatchRequest = z.infer<typeof objectBatchRequestSchema>;

export const objectBatchResponseSchema = z.object({
  updated: z.number().int().min(0),
  errors: z.array(objectErrorSchema),
});
export type ObjectBatchResponse = z.infer<typeof objectBatchResponseSchema>;

/* ---------------------- resumable multipart upload ---------------- */

/**
 * The browser's resumable upload: it drives the multipart upload itself, one part
 * per request, so a dropped connection resumes from the parts already stored
 * instead of starting the object again.
 *
 * S3's own limits, restated because a client has to respect them: every part but
 * the last is at least 5 MiB, and there are at most 10 000 of them.
 */
export const MULTIPART_MIN_PART_SIZE = 5 * 1024 * 1024;
export const MULTIPART_MAX_PARTS = 10_000;

export const createMultipartUploadRequestSchema = z.object({
  key: objectKeySchema,
  contentType: z.string().max(255).nullable(),
  metadata: z.record(z.string(), z.string()),
  tags: z.record(z.string(), z.string()),
  storageClass: z.string().min(1).max(64).nullable(),
});
export type CreateMultipartUploadRequest = z.infer<typeof createMultipartUploadRequestSchema>;

export const createMultipartUploadResponseSchema = z.object({
  uploadId: z.string(),
  key: z.string(),
  /** The part size the client should use, from `Settings.transfers.partSizeMb`. */
  partSizeBytes: z.number().int().min(MULTIPART_MIN_PART_SIZE),
});
export type CreateMultipartUploadResponse = z.infer<typeof createMultipartUploadResponseSchema>;

/** The key travels in the query on every part route, as everywhere else. */
export const multipartKeyQuerySchema = z.object({ key: objectKeySchema });
export type MultipartKeyQuery = z.infer<typeof multipartKeyQuerySchema>;

export const uploadPartResponseSchema = z.object({
  partNumber: z.number().int().min(1).max(MULTIPART_MAX_PARTS),
  etag: z.string(),
  size: z.number().min(0),
});
export type UploadPartResponse = z.infer<typeof uploadPartResponseSchema>;

export const multipartPartSchema = z.object({
  partNumber: z.number().int().min(1).max(MULTIPART_MAX_PARTS),
  etag: z.string(),
  size: z.number().min(0),
});
export type MultipartPart = z.infer<typeof multipartPartSchema>;

/** What a resuming client reads: the parts the server already holds. */
export const multipartPartListSchema = z.object({ parts: z.array(multipartPartSchema) });
export type MultipartPartList = z.infer<typeof multipartPartListSchema>;

export const completedPartSchema = z.object({
  partNumber: z.number().int().min(1).max(MULTIPART_MAX_PARTS),
  etag: z.string().min(1),
});
export type CompletedPart = z.infer<typeof completedPartSchema>;

export const completeMultipartUploadRequestSchema = z.object({
  parts: z.array(completedPartSchema).min(1).max(MULTIPART_MAX_PARTS),
});
export type CompleteMultipartUploadRequest = z.infer<typeof completeMultipartUploadRequestSchema>;

/* --------------------------- archive preview ---------------------- */

/**
 * A listing of what is inside an archive object, for the preview pane.
 *
 * `unsupported` is a real answer rather than an error: the pane asks about any
 * object the operator opens, and "this is not an archive I can read" is what it
 * needs back.
 */
export const ARCHIVE_FORMATS = ['zip', 'tar', 'unsupported'] as const;
export const archiveFormatSchema = z.enum(ARCHIVE_FORMATS);
export type ArchiveFormat = z.infer<typeof archiveFormatSchema>;

export const ARCHIVE_ENTRY_LIMIT_DEFAULT = 500;
export const ARCHIVE_ENTRY_LIMIT_MAX = 5000;

export const archiveEntriesQuerySchema = objectKeyQuerySchema.extend({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ARCHIVE_ENTRY_LIMIT_MAX)
    .default(ARCHIVE_ENTRY_LIMIT_DEFAULT),
});
export type ArchiveEntriesQuery = z.infer<typeof archiveEntriesQuerySchema>;

export const archiveEntrySchema = z.object({
  path: z.string(),
  size: z.number().min(0),
  /** `null` for a format that does not record it, such as tar. */
  compressedSize: z.number().min(0).nullable(),
  modified: isoDateTime.nullable(),
  dir: z.boolean(),
});
export type ArchiveEntry = z.infer<typeof archiveEntrySchema>;

export const archiveEntriesResponseSchema = z.object({
  format: archiveFormatSchema,
  entries: z.array(archiveEntrySchema),
  /** True when the limit or the scan budget stopped the listing early. */
  truncated: z.boolean(),
});
export type ArchiveEntriesResponse = z.infer<typeof archiveEntriesResponseSchema>;
