import type { ListQuotasQuery, Quota, QuotaList, QuotaMode } from '@storage-io/contracts';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * The quotas list and the one write that changes a quota. A quota belongs to a
 * bucket, so the write is `PUT /servers/:sid/buckets/:bucket/quota` and it
 * invalidates the bucket scope as well as this one — the buckets table draws the
 * same number.
 */

export function useQuotas(
  filters: ListQuotasQuery & { readonly page: number; readonly pageSize: number },
): UseQueryResult<QuotaList> {
  return useQuery({
    queryKey: queryKeys.quotas.list(filters),
    queryFn: ({ signal }) => api.get<QuotaList>('/quotas', { ...filters }, signal),
  });
}

export interface SetQuotaVariables {
  readonly serverId: string;
  readonly bucket: string;
  /** `null` removes the quota. */
  readonly limitBytes: number | null;
  readonly mode: QuotaMode;
  readonly threshold: number;
}

export interface SetQuotaResponse {
  readonly quota: Quota | null;
  readonly usage: { readonly sizeBytes: number; readonly objects: number };
}

export function useSetQuota(): UseMutationResult<SetQuotaResponse, Error, SetQuotaVariables> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ serverId, bucket, limitBytes, mode, threshold }) =>
      api.put<SetQuotaResponse>(
        `/servers/${encodeURIComponent(serverId)}/buckets/${encodeURIComponent(bucket)}/quota`,
        { limitBytes, mode, threshold },
      ),
    onSuccess: (_response, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.quotas.all });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.buckets.detail(variables.serverId, variables.bucket),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.buckets.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    },
  });
}

/**
 * The CSV export. `GET /quotas/export.csv` takes the same filters as the list, so
 * the file holds every bucket the filters match — not just the page on screen,
 * which is all a browser-built CSV could have known about.
 */
export function fetchQuotasCsv(filters: ListQuotasQuery): Promise<Blob> {
  return api.blob('/quotas/export.csv', { ...filters });
}
