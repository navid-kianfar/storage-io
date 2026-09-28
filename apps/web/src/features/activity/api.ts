import type { ActivityEvent, ActivityList, ListActivityQuery } from '@storage-io/contracts';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * The activity log. Filters go to the server — the log is the one list that is
 * genuinely large, and filtering 2,400 events in the browser would mean fetching
 * 2,400 events.
 *
 * The CSV export hits `GET /activity/export.csv` with the same filters rather than
 * being rebuilt from the page on screen, so what is exported is what is filtered
 * and not what happens to be paged in.
 */

export interface ActivityFilters extends ListActivityQuery {
  readonly page: number;
  readonly pageSize: number;
}

export function useActivity(filters: ActivityFilters): UseQueryResult<ActivityList> {
  return useQuery({
    queryKey: queryKeys.activity.list(filters),
    queryFn: ({ signal }) => api.get<ActivityList>('/activity', { ...filters }, signal),
    placeholderData: (previous) => previous,
  });
}

export function useActivityEvent(id: string | null): UseQueryResult<ActivityEvent> {
  return useQuery({
    queryKey: queryKeys.activity.detail(id ?? ''),
    queryFn: ({ signal }) =>
      api.get<ActivityEvent>(`/activity/${encodeURIComponent(id ?? '')}`, undefined, signal),
    enabled: id !== null,
  });
}

/** The server-rendered CSV, with whatever filters the page currently has. */
export function fetchActivityCsv(filters: ListActivityQuery): Promise<Blob> {
  return api.blob('/activity/export.csv', { ...filters });
}
