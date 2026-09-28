import type {
  ApiTokenList,
  AuthSessionList,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  HealthResponse,
  ImportSettingsResponse,
  Me,
  Settings,
  TestNotificationRequest,
  TestNotificationResponse,
  UpdateMeRequest,
  UpdateSettingsRequest,
} from '@storage-io/contracts';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { API_BASE_URL, api, request } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * Everything the Settings page reads and writes.
 *
 * `PATCH /settings` takes a partial tree one level deep per section, so each
 * section saves only itself. The response is the whole tree, which is seeded back
 * into the cache instead of triggering a refetch of what was just returned — and it
 * is what makes a save in one section visible in another (region formatting, the
 * transfers card) without a reload.
 *
 * Sessions and CLI tokens are auth state, not settings, so they have their own
 * queries under the `auth` scope.
 */

export function useUpdateSettings(): UseMutationResult<Settings, Error, UpdateSettingsRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.patch<Settings>('/settings', body),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.settings.current(), updated);
    },
  });
}

export function useUpdateProfile(): UseMutationResult<Me, Error, UpdateMeRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.patch<Me>('/auth/me', body),
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.auth.me(), me);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    },
  });
}

/* ------------------------------- sessions -------------------------------- */

export function useAuthSessions(): UseQueryResult<AuthSessionList> {
  return useQuery({
    queryKey: queryKeys.auth.sessions(),
    queryFn: ({ signal }) => api.get<AuthSessionList>('/auth/sessions', undefined, signal),
  });
}

export function useRevokeSession(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId) =>
      api.delete<void>(`/auth/sessions/${encodeURIComponent(sessionId)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.auth.sessions() });
    },
  });
}

export function useRevokeOtherSessions(): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>('/auth/sessions', { others: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.auth.sessions() });
    },
  });
}

/* ------------------------------ CLI tokens ------------------------------- */

export function useApiTokens(): UseQueryResult<ApiTokenList> {
  return useQuery({
    queryKey: queryKeys.auth.tokens(),
    queryFn: ({ signal }) => api.get<ApiTokenList>('/auth/tokens', undefined, signal),
  });
}

export function useCreateApiToken(): UseMutationResult<
  CreateApiTokenResponse,
  Error,
  CreateApiTokenRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.post<CreateApiTokenResponse>('/auth/tokens', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.auth.tokens() });
    },
  });
}

export function useRevokeApiToken(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tokenId) => api.delete<void>(`/auth/tokens/${encodeURIComponent(tokenId)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.auth.tokens() });
    },
  });
}

/* --------------------------- notification tests -------------------------- */

export function useTestNotification(): UseMutationResult<
  TestNotificationResponse,
  Error,
  TestNotificationRequest
> {
  return useMutation({
    mutationFn: (body) => api.post<TestNotificationResponse>('/settings/notifications/test', body),
  });
}

/* ---------------------------- export / import ---------------------------- */

export function useExportConfig(): UseMutationResult<Blob, Error, string> {
  return useMutation({
    mutationFn: (passphrase) =>
      request<Blob>('/settings/export', {
        method: 'POST',
        body: { passphrase },
        accept: 'application/octet-stream',
      }),
  });
}

export interface ImportConfigVariables {
  readonly file: File;
  readonly passphrase: string;
}

export function useImportConfig(): UseMutationResult<
  ImportSettingsResponse,
  Error,
  ImportConfigVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, passphrase }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('passphrase', passphrase);
      return request<ImportSettingsResponse>('/settings/import', { method: 'POST', body: form });
    },
    onSuccess: () => {
      // An import can replace every server and every preference, so nothing in the
      // cache can be assumed to still be true.
      void queryClient.invalidateQueries();
    },
  });
}

/* --------------------------------- about --------------------------------- */

/**
 * Where `/health` actually is.
 *
 * docs/API.md lists it under the `/api/v1` prefix, but the running API answers it
 * at the server root and 404s under the prefix — verified by hand against the dev
 * API. Rather than pick a side and have About say "unreachable" whichever way it is
 * resolved, this tries the contract's path first and falls back to the root, and
 * the discrepancy is reported for the API to settle.
 */
export const HEALTH_ROOT_URL = `${API_BASE_URL.replace(/\/api\/v1$/, '')}/health`;

const HTTP_NOT_FOUND = 404;

async function fetchHealth(signal: AbortSignal): Promise<HealthResponse> {
  const prefixed = await fetch(`${API_BASE_URL}/health`, { credentials: 'include', signal });
  if (prefixed.ok) return (await prefixed.json()) as HealthResponse;
  if (prefixed.status !== HTTP_NOT_FOUND) {
    throw new Error(`Health check failed: ${String(prefixed.status)}`);
  }
  const root = await fetch(HEALTH_ROOT_URL, { credentials: 'include', signal });
  if (!root.ok) throw new Error(`Health check failed: ${String(root.status)}`);
  return (await root.json()) as HealthResponse;
}

export function useHealth(): UseQueryResult<HealthResponse> {
  return useQuery({
    queryKey: queryKeys.health.all,
    queryFn: ({ signal }) => fetchHealth(signal),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Where "Check for updates" looks, if anywhere.
 *
 * storage-io runs on-premise and may have no internet at all, so there is no
 * hard-coded GitHub call: the button only exists when the operator has configured
 * a URL for this deployment. With none set, the About card shows the version it is
 * running and nothing that would fail silently behind a firewall.
 */
export const UPDATE_CHECK_URL: string | undefined = import.meta.env.VITE_UPDATE_CHECK_URL;

export interface UpdateCheckResult {
  readonly version: string;
  readonly url?: string;
  readonly notes?: string;
}

export function useCheckForUpdates(): UseMutationResult<UpdateCheckResult, Error, void> {
  return useMutation({
    mutationFn: async () => {
      if (UPDATE_CHECK_URL === undefined) throw new Error('No update URL is configured.');
      const response = await fetch(UPDATE_CHECK_URL, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Update check failed: ${String(response.status)}`);
      return (await response.json()) as UpdateCheckResult;
    },
  });
}
