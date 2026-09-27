import { SSE_EVENT_NAMES, type SseEventName } from '@storage-io/contracts';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * `GET /api/v1/events` (SSE). One connection for the whole app, opened by the
 * authenticated shell and closed when it unmounts.
 *
 * What each event invalidates is declared once, here. A page never subscribes to
 * the stream itself: it just uses a query, and this hook makes that query stale
 * when the server says the underlying thing changed. That is what keeps a screen
 * live without anyone writing a poll.
 */

export const EVENTS_PATH = '/events';

/** Which query scopes each event makes stale. */
const INVALIDATIONS: Readonly<Record<SseEventName, readonly QueryKey[]>> = {
  'server.health': [queryKeys.servers.all, queryKeys.dashboard.all],
  'job.progress': [queryKeys.jobs.all],
  'job.status': [queryKeys.jobs.all, queryKeys.dashboard.all, queryKeys.activity.all],
  notification: [queryKeys.notifications.all],
  'inventory.updated': [
    queryKeys.buckets.all,
    queryKeys.quotas.all,
    queryKeys.servers.all,
    queryKeys.dashboard.all,
  ],
};

export type StreamStatus = 'connecting' | 'open' | 'closed';

/**
 * A malformed frame is the API's problem. The invalidation still happens — something
 * changed — and the refetch reports the real state; only the payload is lost.
 */
function parseFrame(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function invalidateFor(client: QueryClient, event: SseEventName): void {
  for (const queryKey of INVALIDATIONS[event]) {
    void client.invalidateQueries({ queryKey });
  }
}

export interface UseEventStreamOptions {
  /** False on /login and before `GET /auth/me` resolves: the stream needs a session. */
  readonly enabled?: boolean;
  /** Called for every event, so a page can react beyond invalidation (a toast, say). */
  readonly onEvent?: (event: SseEventName, data: unknown) => void;
}

export function useEventStream({ enabled = true, onEvent }: UseEventStreamOptions = {}): {
  readonly status: StreamStatus;
} {
  const queryClient = useQueryClient();
  // The live status of the connection. When the stream is disabled there is no
  // connection at all, so the reported status is derived rather than stored —
  // which is what keeps setState out of the effect body.
  const [connectionStatus, setConnectionStatus] = useState<StreamStatus>('connecting');
  const status: StreamStatus = enabled ? connectionStatus : 'closed';

  // Kept in a ref so a changing callback does not tear the connection down. The
  // ref is written in an effect, never during render.
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!enabled) return;
    // EventSource reconnects on its own, with the browser's backoff.
    const source = new EventSource(`${API_BASE_URL}${EVENTS_PATH}`, { withCredentials: true });

    const handleOpen = () => setConnectionStatus('open');
    // EventSource reports an error and then retries; "connecting" is the truth.
    const handleError = () => setConnectionStatus('connecting');

    source.addEventListener('open', handleOpen);
    source.addEventListener('error', handleError);

    const listeners = SSE_EVENT_NAMES.map((name) => {
      const listener = (message: MessageEvent<string>) => {
        invalidateFor(queryClient, name);
        onEventRef.current?.(name, parseFrame(message.data));
      };
      source.addEventListener(name, listener as EventListener);
      return [name, listener] as const;
    });

    return () => {
      source.removeEventListener('open', handleOpen);
      source.removeEventListener('error', handleError);
      for (const [name, listener] of listeners) {
        source.removeEventListener(name, listener as EventListener);
      }
      source.close();
    };
  }, [enabled, queryClient]);

  return { status };
}
