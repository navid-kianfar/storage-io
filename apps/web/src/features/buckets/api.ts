import type {
  Bucket,
  BucketAccessBody,
  BucketAccessResponse,
  BucketBulkRequest,
  BucketBulkResponse,
  BucketCorsBody,
  BucketDetail,
  BucketLifecycleBody,
  BucketList,
  BucketNotificationsBody,
  BucketObjectLockBody,
  BucketObjectLockResponse,
  BucketPolicyBody,
  BucketQuotaBody,
  BucketQuotaResponse,
  BucketReplicationBody,
  BucketReplicationResponse,
  BucketSort,
  BucketTagsBody,
  BucketVersioningBody,
  CreateBucketRequest,
  EmptyBucketRequest,
  Job,
  NotificationTargetStatusList,
} from '@storage-io/contracts';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * Every request the buckets pages make. Nothing else in the app talks to
 * `/buckets` or to a bucket sub-resource, which is what makes the later
 * "run it against the real API" pass mechanical.
 *
 * Two shapes recur:
 *
 * - the *list*, whose filters are part of its query key, so two filter sets are
 *   two cache entries and going back to a previous filter is instant.
 * - a *section* (`policy`, `lifecycle`, `cors`, `quota`, …), a GET/PUT pair under
 *   `/servers/:sid/buckets/:bucket/<section>`. They share one generic hook rather
 *   than ten copies of the same five lines.
 */

export interface BucketRefParams {
  /** The server's id or its name — `GET /servers/:id` accepts either. */
  readonly serverId: string;
  readonly bucket: string;
}

export interface BucketListFilters {
  readonly q?: string;
  readonly serverId?: string;
  readonly access?: Bucket['access'];
  readonly sort: BucketSort;
  readonly page: number;
  readonly pageSize: number;
}

/** The ids a bucket row is keyed by: `serverId/name` is unique across servers. */
export function bucketRowId(bucket: BucketRefParams | Bucket): string {
  const name = 'bucket' in bucket ? bucket.bucket : bucket.name;
  return `${bucket.serverId}/${name}`;
}

export function parseBucketRowId(rowId: string): BucketRefParams {
  const separator = rowId.indexOf('/');
  return { serverId: rowId.slice(0, separator), bucket: rowId.slice(separator + 1) };
}

function bucketPath({ serverId, bucket }: BucketRefParams, section = ''): string {
  const suffix = section === '' ? '' : `/${section}`;
  return `/servers/${encodeURIComponent(serverId)}/buckets/${encodeURIComponent(bucket)}${suffix}`;
}

/** `s3://bucket/prefix` — what every "Copy S3 URI" action puts on the clipboard. */
export function s3Uri(bucket: string, prefix = ''): string {
  return `s3://${bucket}/${prefix}`;
}

/* ------------------------------- the list ------------------------------- */

export function useBuckets(filters: BucketListFilters): UseQueryResult<BucketList> {
  return useQuery({
    queryKey: queryKeys.buckets.list(filters),
    queryFn: ({ signal }) =>
      api.get<BucketList>(
        '/buckets',
        {
          q: filters.q,
          serverId: filters.serverId,
          access: filters.access,
          sort: filters.sort,
          page: filters.page,
          pageSize: filters.pageSize,
        },
        signal,
      ),
  });
}

/**
 * The same list without pagination, for the CSV export. There is no
 * `/buckets/export.csv` endpoint (docs/API.md has one for activity and IAM only),
 * so the file is built in the browser from one full page.
 */
export const BUCKET_EXPORT_PAGE_SIZE = 500;

export async function fetchAllBuckets(
  filters: Omit<BucketListFilters, 'page' | 'pageSize'>,
): Promise<BucketList> {
  return api.get<BucketList>('/buckets', {
    q: filters.q,
    serverId: filters.serverId,
    access: filters.access,
    sort: filters.sort,
    page: 1,
    pageSize: BUCKET_EXPORT_PAGE_SIZE,
  });
}

/* ------------------------------ one bucket ------------------------------ */

export function useBucketDetail(
  ref: BucketRefParams,
  enabled = true,
): UseQueryResult<BucketDetail> {
  return useQuery({
    queryKey: queryKeys.buckets.detail(ref.serverId, ref.bucket),
    queryFn: ({ signal }) => api.get<BucketDetail>(bucketPath(ref), undefined, signal),
    enabled,
  });
}

/* ------------------------------- sections ------------------------------- */

/**
 * A bucket sub-resource. `enabled` is how a page switches a section off when the
 * provider does not support it — asking anyway would only produce a
 * `NOT_SUPPORTED` problem the operator has already been told about.
 */
function useBucketSection<TResult>(
  ref: BucketRefParams,
  section: string,
  enabled: boolean,
): UseQueryResult<TResult> {
  return useQuery({
    queryKey: queryKeys.buckets.section(ref.serverId, ref.bucket, section),
    queryFn: ({ signal }) => api.get<TResult>(bucketPath(ref, section), undefined, signal),
    enabled,
    retry: false,
  });
}

export const useBucketTags = (ref: BucketRefParams, enabled = true) =>
  useBucketSection<BucketTagsBody>(ref, 'tags', enabled);

export const useBucketAccess = (ref: BucketRefParams, enabled = true) =>
  useBucketSection<BucketAccessResponse>(ref, 'access', enabled);

export const useBucketPolicy = (ref: BucketRefParams, enabled = true) =>
  useBucketSection<BucketPolicyBody>(ref, 'policy', enabled);

export const useBucketQuota = (ref: BucketRefParams, enabled = true) =>
  useBucketSection<BucketQuotaResponse>(ref, 'quota', enabled);

export const useBucketVersioning = (ref: BucketRefParams, enabled = true) =>
  useBucketSection<BucketVersioningBody>(ref, 'versioning', enabled);

export const useBucketObjectLock = (ref: BucketRefParams, enabled = true) =>
  useBucketSection<BucketObjectLockResponse>(ref, 'object-lock', enabled);

export const useBucketLifecycle = (ref: BucketRefParams, enabled = true) =>
  useBucketSection<BucketLifecycleBody>(ref, 'lifecycle', enabled);

export const useBucketCors = (ref: BucketRefParams, enabled = true) =>
  useBucketSection<BucketCorsBody>(ref, 'cors', enabled);

export const useBucketReplication = (ref: BucketRefParams, enabled = true) =>
  useBucketSection<BucketReplicationResponse>(ref, 'replication', enabled);

export const useBucketNotifications = (ref: BucketRefParams, enabled = true) =>
  useBucketSection<BucketNotificationsBody>(ref, 'notifications', enabled);

export const useBucketNotificationStatus = (ref: BucketRefParams, enabled = true) =>
  useBucketSection<NotificationTargetStatusList>(ref, 'notifications/status', enabled);

/* ------------------------------ invalidation ---------------------------- */

/**
 * After any write, both the bucket's own entries and the aggregated list are
 * stale: the list carries size, quota and access for every bucket.
 */
function invalidateBucket(client: QueryClient, ref: BucketRefParams): void {
  void client.invalidateQueries({ queryKey: queryKeys.buckets.detail(ref.serverId, ref.bucket) });
  void client.invalidateQueries({ queryKey: queryKeys.buckets.all });
  void client.invalidateQueries({ queryKey: queryKeys.quotas.all });
}

/* ------------------------------- mutations ------------------------------ */

export interface CreateBucketVariables extends CreateBucketRequest {
  readonly serverId: string;
}

export function useCreateBucket() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ serverId, ...body }: CreateBucketVariables) =>
      api.post<Bucket>(`/servers/${encodeURIComponent(serverId)}/buckets`, body),
    onSuccess: (created) => {
      invalidateBucket(client, { serverId: created.serverId, bucket: created.name });
      void client.invalidateQueries({ queryKey: queryKeys.servers.all });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    },
  });
}

export function useDeleteBucket() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ force, ...ref }: BucketRefParams & { readonly force: boolean }) =>
      api.delete<void>(bucketPath(ref), { force }),
    onSuccess: (_result, variables) => {
      invalidateBucket(client, variables);
      void client.invalidateQueries({ queryKey: queryKeys.servers.all });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    },
  });
}

/** Emptying is a job: the answer is the job, not a finished result. */
export function useEmptyBucket() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ includeVersions, ...ref }: BucketRefParams & EmptyBucketRequest) =>
      api.post<Job>(bucketPath(ref, 'empty'), { includeVersions } satisfies EmptyBucketRequest),
    onSuccess: (_job, variables) => {
      invalidateBucket(client, variables);
      void client.invalidateQueries({ queryKey: queryKeys.jobs.all });
    },
  });
}

/** One PUT per section, all through the same mutation so invalidation is uniform. */
function useSectionMutation<TBody, TResult>(section: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, body }: { readonly ref: BucketRefParams; readonly body: TBody }) =>
      api.put<TResult>(bucketPath(ref, section), body),
    onSuccess: (_result, variables) => {
      void client.invalidateQueries({
        queryKey: queryKeys.buckets.section(variables.ref.serverId, variables.ref.bucket, section),
      });
      invalidateBucket(client, variables.ref);
    },
  });
}

export const useSaveBucketTags = () => useSectionMutation<BucketTagsBody, BucketTagsBody>('tags');
export const useSaveBucketAccess = () =>
  useSectionMutation<BucketAccessBody, BucketAccessResponse>('access');
export const useSaveBucketPolicy = () =>
  useSectionMutation<BucketPolicyBody, BucketPolicyBody>('policy');
export const useSaveBucketQuota = () =>
  useSectionMutation<BucketQuotaBody, BucketQuotaResponse>('quota');
export const useSaveBucketVersioning = () =>
  useSectionMutation<BucketVersioningBody, BucketVersioningBody>('versioning');
export const useSaveBucketObjectLock = () =>
  useSectionMutation<BucketObjectLockBody, BucketObjectLockResponse>('object-lock');
export const useSaveBucketLifecycle = () =>
  useSectionMutation<BucketLifecycleBody, BucketLifecycleBody>('lifecycle');
export const useSaveBucketCors = () => useSectionMutation<BucketCorsBody, BucketCorsBody>('cors');
export const useSaveBucketReplication = () =>
  useSectionMutation<BucketReplicationBody, BucketReplicationResponse>('replication');
export const useSaveBucketNotifications = () =>
  useSectionMutation<BucketNotificationsBody, BucketNotificationsBody>('notifications');

/**
 * The bulk bar's one request. Deliberately not a loop over the selection:
 * `POST /buckets/bulk` applies one action to up to 500 buckets and answers with a
 * per-bucket result, so a partial failure can be reported precisely.
 */
export function useBucketBulkAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BucketBulkRequest) => api.post<BucketBulkResponse>('/buckets/bulk', body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.buckets.all });
      void client.invalidateQueries({ queryKey: queryKeys.quotas.all });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    },
  });
}
