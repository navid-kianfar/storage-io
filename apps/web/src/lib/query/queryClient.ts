import { QueryClient } from '@tanstack/react-query';
import { isApiError } from '@/lib/api/errors';

const THIRTY_SECONDS_MS = 30_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const MAX_RETRIES = 2;

/**
 * Defaults chosen for an on-premise console with a live SSE stream:
 *
 * - `staleTime` 30 s, because `useEventStream` invalidates what actually changed;
 *   polling on top of that would only add load to the storage servers.
 * - No refetch on window focus: an admin switching windows does not mean the
 *   bucket list changed, and a focus refetch on a slow provider is visible.
 * - Retries never apply to a 4xx. Retrying a 401 or a 409 cannot succeed, and
 *   retrying a 401 delays the redirect to /login.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: THIRTY_SECONDS_MS,
        gcTime: FIVE_MINUTES_MS,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          if (failureCount >= MAX_RETRIES) return false;
          if (!isApiError(error)) return false;
          // A network failure is worth retrying; a refused request is not.
          if (error.isNetworkError) return true;
          return error.status >= 500;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}
