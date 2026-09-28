import {
  ARCHIVE_ENTRY_LIMIT_DEFAULT,
  OBJECT_BATCH_MAX_KEYS,
  OBJECT_LIST_LIMIT_DEFAULT,
  type ArchiveEntriesResponse,
  type CompleteMultipartUploadRequest,
  type CopyObjectsRequest,
  type CopyObjectsResponse,
  type CreateMultipartUploadRequest,
  type CreateMultipartUploadResponse,
  type DeleteObjectsRequest,
  type DeleteObjectsResponse,
  type DownloadZipRequest,
  type ImportObjectFromUrlRequest,
  type ListObjectsResponse,
  type MultipartPartList,
  type ObjectBatchRequest,
  type ObjectBatchResponse,
  type ObjectItem,
  type ObjectMeta,
  type ObjectMetadataBody,
  type ObjectRetentionBody,
  type ObjectTagsBody,
  type ObjectVersionList,
  type PresignRequest,
  type PresignResponse,
  type RenameObjectRequest,
  type RestoreVersionRequest,
  type SetObjectStorageClassRequest,
} from '@storage-io/contracts';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api, buildUrl, request } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * Every request the object browser makes.
 *
 * The listing is an infinite query keyed by the prefix and the filter: the API
 * pages objects with an opaque `cursor`, not a page number, so "load more" is
 * `fetchNextPage` and there is no way to jump to page 7. Two different prefixes
 * are two cache entries, which is what makes walking back up a folder instant.
 */

export interface ObjectScope {
  /** The server's id or its name. */
  readonly serverId: string;
  readonly bucket: string;
}

export interface ObjectListFilters {
  readonly prefix: string;
  readonly q?: string;
  readonly showVersions: boolean;
  readonly limit?: number;
}

export function objectsPath(scope: ObjectScope, section = ''): string {
  const suffix = section === '' ? '' : `/${section}`;
  return `/servers/${encodeURIComponent(scope.serverId)}/buckets/${encodeURIComponent(scope.bucket)}/objects${suffix}`;
}

/** The folder a key sits in, and the name shown in the listing. */
export function keyName(key: string): string {
  const withoutTrailingSlash = key.endsWith('/') ? key.slice(0, -1) : key;
  const lastSlash = withoutTrailingSlash.lastIndexOf('/');
  return lastSlash === -1 ? withoutTrailingSlash : withoutTrailingSlash.slice(lastSlash + 1);
}

export function parentPrefix(prefix: string): string {
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const lastSlash = trimmed.lastIndexOf('/');
  return lastSlash === -1 ? '' : trimmed.slice(0, lastSlash + 1);
}

/** `["2026/", "2026/09/", "2026/09/campaign/"]` — the path bar's crumbs. */
export function prefixSegments(prefix: string): readonly { name: string; prefix: string }[] {
  if (prefix === '') return [];
  const parts = prefix.split('/').filter((part) => part !== '');
  const crumbs: { name: string; prefix: string }[] = [];
  let walked = '';
  for (const part of parts) {
    walked += `${part}/`;
    crumbs.push({ name: part, prefix: walked });
  }
  return crumbs;
}

/* ------------------------------- listing -------------------------------- */

export function useObjectListing(scope: ObjectScope, filters: ObjectListFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.objects.list(scope.serverId, scope.bucket, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get<ListObjectsResponse>(
        objectsPath(scope),
        {
          prefix: filters.prefix,
          // Always delimited. "Show versions" is a filter *within* the current
          // folder — the API answers with this level's sub-prefixes plus every
          // version of the objects in it — so a flat listing would lose the
          // folders the operator is standing in. (An empty `delimiter` would in
          // any case be dropped by `buildUrl`, which treats '' as absent.)
          delimiter: '/',
          cursor: pageParam,
          limit: filters.limit ?? OBJECT_LIST_LIMIT_DEFAULT,
          q: filters.q,
          showVersions: filters.showVersions,
        },
        signal,
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // The scope's own parts are guarded here, not only by the caller, for the
    // same reason `useObjectMeta` guards its key below: the browser reaches a
    // bucket by opaque id and holds an empty scope until that id resolves, and
    // an unresolved scope builds `/servers//buckets//objects`, which 404s.
    enabled: enabled && scope.serverId !== '' && scope.bucket !== '',
  });
}

/* ------------------------------ one object ------------------------------ */

export function useObjectMeta(
  scope: ObjectScope,
  key: string | null,
  versionId?: string,
): UseQueryResult<ObjectMeta> {
  return useQuery({
    queryKey: queryKeys.objects.meta(scope.serverId, scope.bucket, key ?? '', versionId),
    queryFn: ({ signal }) =>
      api.get<ObjectMeta>(objectsPath(scope, 'meta'), { key: key ?? '', versionId }, signal),
    enabled: key !== null && key !== '' && !key.endsWith('/'),
    retry: false,
  });
}

export function useObjectVersions(
  scope: ObjectScope,
  key: string | null,
  enabled = true,
): UseQueryResult<ObjectVersionList> {
  return useQuery({
    queryKey: queryKeys.objects.versions(scope.serverId, scope.bucket, key ?? ''),
    queryFn: ({ signal }) =>
      api.get<ObjectVersionList>(objectsPath(scope, 'versions'), { key: key ?? '' }, signal),
    enabled: enabled && key !== null && key !== '' && !key.endsWith('/'),
    retry: false,
  });
}

/**
 * The URL of an object's bytes. Used for `<img>`, `<video>`, `<audio>` and the PDF
 * frame in the inspector, and for the plain download link.
 *
 * `inline=true` makes the API send `Content-Disposition: inline`, which is what
 * lets the browser render it rather than save it.
 */
export function objectContentUrl(
  scope: ObjectScope,
  key: string,
  { versionId, inline }: { readonly versionId?: string; readonly inline: boolean },
): string {
  return buildUrl(objectsPath(scope, 'download'), { key, versionId, inline });
}

/** The object's bytes as text, for the read-only text/JSON/Markdown previews. */
export async function fetchObjectText(
  scope: ObjectScope,
  key: string,
  versionId?: string,
): Promise<string> {
  const blob = await api.blob(objectsPath(scope, 'download'), { key, versionId, inline: true });
  return blob.text();
}

/* ------------------------------ invalidation ---------------------------- */

/**
 * Anything that changes an object makes the listing for its prefix stale, and the
 * bucket's own size and object count with it.
 */
function invalidateObjects(client: QueryClient, scope: ObjectScope): void {
  void client.invalidateQueries({ queryKey: queryKeys.objects.all });
  void client.invalidateQueries({
    queryKey: queryKeys.buckets.detail(scope.serverId, scope.bucket),
  });
  void client.invalidateQueries({ queryKey: queryKeys.buckets.list() });
}

/* ------------------------------- mutations ------------------------------ */

export function useCreateFolder(scope: ObjectScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (prefix: string) => api.post<void>(objectsPath(scope, 'folder'), { prefix }),
    onSuccess: () => invalidateObjects(client, scope),
  });
}

export function useDeleteObjects(scope: ObjectScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: DeleteObjectsRequest) =>
      api.post<DeleteObjectsResponse>(objectsPath(scope, 'delete'), body),
    onSuccess: (response) => {
      invalidateObjects(client, scope);
      if (response.job !== null) void client.invalidateQueries({ queryKey: queryKeys.jobs.all });
    },
  });
}

/** Copy and move are one endpoint; `move` decides whether the source is removed. */
export function useCopyObjects(scope: ObjectScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CopyObjectsRequest) =>
      api.post<CopyObjectsResponse>(objectsPath(scope, 'copy'), body),
    onSuccess: (response) => {
      invalidateObjects(client, scope);
      if (response.job !== null) void client.invalidateQueries({ queryKey: queryKeys.jobs.all });
    },
  });
}

export function useRenameObject(scope: ObjectScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RenameObjectRequest) =>
      api.post<ObjectItem>(objectsPath(scope, 'rename'), body),
    onSuccess: () => invalidateObjects(client, scope),
  });
}

export function useRestoreVersion(scope: ObjectScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RestoreVersionRequest) =>
      api.post<ObjectItem>(objectsPath(scope, 'restore-version'), body),
    onSuccess: () => invalidateObjects(client, scope),
  });
}

export function useSaveObjectTags(scope: ObjectScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      key,
      versionId,
      tags,
    }: { readonly key: string; readonly versionId?: string } & ObjectTagsBody) =>
      api.put<ObjectTagsBody>(objectsPath(scope, 'tags'), { tags }, { key, versionId }),
    onSuccess: () => invalidateObjects(client, scope),
  });
}

export function useSaveObjectMetadata(scope: ObjectScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...body }: { readonly key: string } & ObjectMetadataBody) =>
      api.put<ObjectMeta>(objectsPath(scope, 'metadata'), body, { key }),
    onSuccess: () => invalidateObjects(client, scope),
  });
}

export function useSetStorageClass(scope: ObjectScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      key,
      storageClass,
    }: { readonly key: string } & SetObjectStorageClassRequest) =>
      api.put<ObjectMeta>(objectsPath(scope, 'storage-class'), { storageClass }, { key }),
    onSuccess: () => invalidateObjects(client, scope),
  });
}

export function useSetRetention(scope: ObjectScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      key,
      versionId,
      body,
    }: {
      readonly key: string;
      readonly versionId?: string;
      readonly body: ObjectRetentionBody;
    }) => api.put<ObjectMeta>(objectsPath(scope, 'retention'), body, { key, versionId }),
    onSuccess: () => invalidateObjects(client, scope),
  });
}

export function usePresignObject(scope: ObjectScope) {
  return useMutation({
    mutationFn: (body: PresignRequest) =>
      api.post<PresignResponse>(objectsPath(scope, 'presign'), body),
  });
}

export function useImportFromUrl(scope: ObjectScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportObjectFromUrlRequest) =>
      api.post<ObjectItem>(objectsPath(scope, 'import-url'), body),
    onSuccess: () => invalidateObjects(client, scope),
  });
}

/** Saving edited contents creates a new version; the text goes as the raw body. */
export function usePutObjectContent(scope: ObjectScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ key, content }: { readonly key: string; readonly content: string }) =>
      request<ObjectItem>(objectsPath(scope, 'content'), {
        method: 'PUT',
        query: { key },
        body: content,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }),
    onSuccess: () => invalidateObjects(client, scope),
  });
}

/**
 * One metadata-only action over an explicit selection, applied in the request.
 *
 * Bounded by the API at {@link OBJECT_BATCH_MAX_KEYS}: above that the operator is
 * no longer waiting for it and the work belongs to a job. Call sites check
 * {@link fitsInOneBatch} before offering this path.
 *
 * The response is per-key: `updated` plus an `errors` array. A provider that lacks
 * the feature altogether answers 409 `NOT_SUPPORTED` instead, which arrives here as
 * an `ApiError`.
 */
export function useObjectBatch(scope: ObjectScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ObjectBatchRequest) =>
      api.post<ObjectBatchResponse>(objectsPath(scope, 'batch'), body),
    onSuccess: () => invalidateObjects(client, scope),
  });
}

export function fitsInOneBatch(keyCount: number): boolean {
  return keyCount > 0 && keyCount <= OBJECT_BATCH_MAX_KEYS;
}

/**
 * What is inside an archive object, for the preview pane.
 *
 * `format: 'unsupported'` is a normal answer, not an error, so this never retries:
 * asking twice about an object that is not an archive gets the same answer.
 */
export function useArchiveEntries(
  scope: ObjectScope,
  key: string | null,
  versionId?: string,
  enabled = true,
): UseQueryResult<ArchiveEntriesResponse> {
  return useQuery({
    queryKey: queryKeys.objects.archiveEntries(scope.serverId, scope.bucket, key ?? '', versionId),
    queryFn: ({ signal }) =>
      api.get<ArchiveEntriesResponse>(
        objectsPath(scope, 'archive-entries'),
        { key: key ?? '', versionId, limit: ARCHIVE_ENTRY_LIMIT_DEFAULT },
        signal,
      ),
    enabled: enabled && key !== null && key !== '' && !key.endsWith('/'),
    retry: false,
  });
}

/* --------------------------- multipart upload ---------------------------- */

/**
 * The multipart endpoints, as plain functions rather than hooks: the transfer
 * engine is a module singleton that outlives the object browser, so it cannot use
 * React Query. They live here anyway, because this file is the only place in the
 * app that knows the object URLs.
 *
 * `uploadId` is opaque and provider-generated — MinIO's is base64, which contains
 * characters that mean something in a path — so every route below encodes it.
 */
function multipartPath(scope: ObjectScope, uploadId: string, section = ''): string {
  const suffix = section === '' ? '' : `/${section}`;
  return `${objectsPath(scope, 'multipart')}/${encodeURIComponent(uploadId)}${suffix}`;
}

export function createMultipartUpload(
  scope: ObjectScope,
  body: CreateMultipartUploadRequest,
): Promise<CreateMultipartUploadResponse> {
  return api.post<CreateMultipartUploadResponse>(objectsPath(scope, 'multipart'), body);
}

/** The parts the server already holds — what makes a resume a resume. */
export function listMultipartParts(
  scope: ObjectScope,
  uploadId: string,
  key: string,
): Promise<MultipartPartList> {
  return api.get<MultipartPartList>(multipartPath(scope, uploadId), { key });
}

export function completeMultipartUpload(
  scope: ObjectScope,
  uploadId: string,
  key: string,
  body: CompleteMultipartUploadRequest,
): Promise<ObjectItem> {
  return api.post<ObjectItem>(multipartPath(scope, uploadId, 'complete'), body, { key });
}

export function abortMultipartUpload(
  scope: ObjectScope,
  uploadId: string,
  key: string,
): Promise<void> {
  return api.delete<void>(multipartPath(scope, uploadId), { key });
}

/**
 * The URL one part is PUT to. The engine sends the part itself with XHR, because
 * `fetch` still cannot report upload progress.
 */
export function multipartPartUrl(
  scope: ObjectScope,
  uploadId: string,
  partNumber: number,
  key: string,
): string {
  return buildUrl(multipartPath(scope, uploadId, `parts/${String(partNumber)}`), { key });
}

/**
 * A ZIP of the selection. The response is a stream, so this is a mutation that
 * answers with a Blob rather than a query — nothing about it is cacheable.
 */
export function useDownloadZip(scope: ObjectScope) {
  return useMutation({
    mutationFn: (body: DownloadZipRequest) =>
      request<Blob>(objectsPath(scope, 'download-zip'), {
        method: 'POST',
        body,
        accept: 'application/zip',
      }),
  });
}
