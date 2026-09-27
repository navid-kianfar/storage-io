import type {
  Dashboard,
  MarkNotificationsReadRequest,
  NotificationList,
  SearchResponse,
  ServerList,
  Settings,
} from '@storage-io/contracts';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * The queries the shell itself needs: the server list for the switcher, the
 * dashboard totals for the sidebar counts and storage card, notifications for the
 * popover, settings for region formatting, and the palette's live search.
 *
 * Page-specific queries live with their feature, not here.
 */

const SEARCH_MIN_LENGTH = 2;
const SEARCH_DEBOUNCE_STALE_MS = 15_000;

export function useServerList(): UseQueryResult<ServerList> {
  return useQuery({
    queryKey: queryKeys.servers.list(),
    queryFn: () => api.get<ServerList>('/servers'),
  });
}

export function useDashboard(): UseQueryResult<Dashboard> {
  return useQuery({
    queryKey: queryKeys.dashboard.overview(),
    queryFn: () => api.get<Dashboard>('/dashboard'),
  });
}

export function useSettings(): UseQueryResult<Settings> {
  return useQuery({
    queryKey: queryKeys.settings.current(),
    queryFn: () => api.get<Settings>('/settings'),
  });
}

export function useNotifications(unreadOnly = false): UseQueryResult<NotificationList> {
  return useQuery({
    queryKey: queryKeys.notifications.list(unreadOnly),
    queryFn: () =>
      api.get<NotificationList>('/notifications', unreadOnly ? { unread: true } : undefined),
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: MarkNotificationsReadRequest['ids']) =>
      api.post<void>('/notifications/read', { ids } satisfies MarkNotificationsReadRequest),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    },
  });
}

/**
 * The palette's live results. Disabled below two characters, because a one-letter
 * search across every server is expensive and useless.
 */
export function useGlobalSearch(term: string): UseQueryResult<SearchResponse> {
  const trimmed = term.trim();
  return useQuery({
    queryKey: queryKeys.search.query(trimmed),
    queryFn: ({ signal }) => api.get<SearchResponse>('/search', { q: trimmed }, signal),
    enabled: trimmed.length >= SEARCH_MIN_LENGTH,
    staleTime: SEARCH_DEBOUNCE_STALE_MS,
    placeholderData: (previous) => previous,
  });
}
