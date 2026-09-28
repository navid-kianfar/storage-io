import type {
  BucketList,
  BucketSort,
  CreateServerRequest,
  ListServersQuery,
  MetricRange,
  RotateServerCredentialsRequest,
  RotateServerCredentialsResponse,
  S3UserList,
  Server,
  ServerDriveList,
  ServerHealthEventList,
  ServerList,
  ServerMetrics,
  ServerNodeList,
  TestServerResponse,
  UpdateServerRequest,
} from '@storage-io/contracts';
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
 * Every request the servers pages make. Nothing else in the app calls
 * `/servers…` directly, so the later integration pass against the real API
 * touches this file and nothing else.
 *
 * Invalidation is precise but never narrower than the truth: adding, editing,
 * removing or rotating a server changes the dashboard's totals and the sidebar's
 * switcher too, so those mutations invalidate `dashboard` as well.
 */

const SERVER_EVENT_LIMIT = 8;

export function useServers(filters?: ListServersQuery): UseQueryResult<ServerList> {
  return useQuery({
    queryKey: queryKeys.servers.list(filters ?? null),
    queryFn: ({ signal }) => api.get<ServerList>('/servers', filters, signal),
  });
}

/** `serverId` accepts the id or the slug name, as docs/API.md states. */
export function useServer(serverId: string): UseQueryResult<Server> {
  return useQuery({
    queryKey: queryKeys.servers.detail(serverId),
    queryFn: ({ signal }) => api.get<Server>(`/servers/${encodeURIComponent(serverId)}`, undefined, signal),
    enabled: serverId.length > 0,
  });
}

export function useServerMetrics(
  serverId: string,
  range: MetricRange,
): UseQueryResult<ServerMetrics> {
  return useQuery({
    queryKey: queryKeys.servers.metrics(serverId, range),
    queryFn: ({ signal }) =>
      api.get<ServerMetrics>(`/servers/${encodeURIComponent(serverId)}/metrics`, { range }, signal),
    enabled: serverId.length > 0,
  });
}

export function useServerNodes(
  serverId: string,
  enabled: boolean,
): UseQueryResult<ServerNodeList> {
  return useQuery({
    queryKey: queryKeys.servers.nodes(serverId),
    queryFn: ({ signal }) =>
      api.get<ServerNodeList>(`/servers/${encodeURIComponent(serverId)}/nodes`, undefined, signal),
    enabled: enabled && serverId.length > 0,
    // A driver without the `nodes` capability answers NOT_SUPPORTED; retrying
    // that is pointless and the page shows the unsupported state instead.
    retry: false,
  });
}

export function useServerDrives(
  serverId: string,
  node: string | null,
): UseQueryResult<ServerDriveList> {
  return useQuery({
    queryKey: queryKeys.servers.drives(serverId, node ?? ''),
    queryFn: ({ signal }) =>
      api.get<ServerDriveList>(
        `/servers/${encodeURIComponent(serverId)}/nodes/${encodeURIComponent(node ?? '')}/drives`,
        undefined,
        signal,
      ),
    enabled: node !== null && serverId.length > 0,
    retry: false,
  });
}

export function useServerEvents(serverId: string): UseQueryResult<ServerHealthEventList> {
  return useQuery({
    queryKey: queryKeys.servers.events(serverId, SERVER_EVENT_LIMIT),
    queryFn: ({ signal }) =>
      api.get<ServerHealthEventList>(
        `/servers/${encodeURIComponent(serverId)}/events`,
        { limit: SERVER_EVENT_LIMIT },
        signal,
      ),
    enabled: serverId.length > 0,
  });
}

/**
 * The two cross-domain reads the server page needs for its Buckets and
 * Users & keys tabs. They are here rather than in `features/buckets` and
 * `features/iam` deliberately: those modules belong to the buckets and access
 * pages, and this page only ever reads a list scoped to one server. If a later
 * pass moves them, this is the only call site.
 */
export function useServerBuckets(
  serverId: string,
  options: {
    readonly q: string;
    readonly page: number;
    readonly pageSize: number;
    readonly sort: BucketSort;
    readonly enabled: boolean;
  },
): UseQueryResult<BucketList> {
  const filters = {
    serverId,
    sort: options.sort,
    page: options.page,
    pageSize: options.pageSize,
    ...(options.q.length > 0 ? { q: options.q } : {}),
  };
  return useQuery({
    queryKey: queryKeys.buckets.list(filters),
    queryFn: ({ signal }) => api.get<BucketList>('/buckets', filters, signal),
    enabled: options.enabled && serverId.length > 0,
  });
}

export function useServerIamUsers(
  serverId: string,
  options: { readonly page: number; readonly pageSize: number; readonly enabled: boolean },
): UseQueryResult<S3UserList> {
  const filters = { serverId, page: options.page, pageSize: options.pageSize };
  return useQuery({
    queryKey: queryKeys.iam.users(filters),
    queryFn: ({ signal }) => api.get<S3UserList>('/iam/users', filters, signal),
    enabled: options.enabled && serverId.length > 0,
    retry: false,
  });
}

/* --------------------------- mutations ---------------------------- */

function useServerScopeInvalidation() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
  };
}

/** The unsaved-connection test used by /welcome and the Add-server wizard. */
export function useTestConnection(): UseMutationResult<
  TestServerResponse,
  Error,
  CreateServerRequest
> {
  return useMutation({
    mutationFn: (body: CreateServerRequest) => api.post<TestServerResponse>('/servers/test', body),
  });
}

/** The saved-connection test, from a server card or the Connection tab. */
export function useTestServer(): UseMutationResult<TestServerResponse, Error, string> {
  return useMutation({
    mutationFn: (serverId: string) =>
      api.post<TestServerResponse>(`/servers/${encodeURIComponent(serverId)}/test`),
  });
}

export function useCreateServer(): UseMutationResult<Server, Error, CreateServerRequest> {
  const invalidate = useServerScopeInvalidation();
  return useMutation({
    mutationFn: (body: CreateServerRequest) => api.post<Server>('/servers', body),
    onSuccess: invalidate,
  });
}

export function useUpdateServer(): UseMutationResult<
  Server,
  Error,
  { readonly serverId: string; readonly body: UpdateServerRequest }
> {
  const invalidate = useServerScopeInvalidation();
  return useMutation({
    mutationFn: ({ serverId, body }) =>
      api.patch<Server>(`/servers/${encodeURIComponent(serverId)}`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteServer(): UseMutationResult<void, Error, string> {
  const invalidate = useServerScopeInvalidation();
  return useMutation({
    mutationFn: (serverId: string) => api.delete<void>(`/servers/${encodeURIComponent(serverId)}`),
    onSuccess: invalidate,
  });
}

/** Runs a health check now and returns the refreshed server. */
export function useCheckServer(): UseMutationResult<Server, Error, string> {
  const invalidate = useServerScopeInvalidation();
  return useMutation({
    mutationFn: (serverId: string) =>
      api.post<Server>(`/servers/${encodeURIComponent(serverId)}/check`),
    onSuccess: invalidate,
  });
}

/**
 * One request for every server — the checks then run in the background and the
 * SSE `server.health` events invalidate the list as each finishes.
 */
export function useCheckAllServers(): UseMutationResult<void, Error, void> {
  return useMutation({
    mutationFn: () => api.post<void>('/servers/check-all'),
  });
}

export function useSetMaintenance(): UseMutationResult<
  Server,
  Error,
  { readonly serverId: string; readonly enabled: boolean }
> {
  const invalidate = useServerScopeInvalidation();
  return useMutation({
    mutationFn: ({ serverId, enabled }) =>
      api.put<Server>(`/servers/${encodeURIComponent(serverId)}/maintenance`, { enabled }),
    onSuccess: invalidate,
  });
}

export function useRotateServerCredentials(): UseMutationResult<
  RotateServerCredentialsResponse,
  Error,
  { readonly serverId: string; readonly body: RotateServerCredentialsRequest }
> {
  const invalidate = useServerScopeInvalidation();
  return useMutation({
    mutationFn: ({ serverId, body }) =>
      api.post<RotateServerCredentialsResponse>(
        `/servers/${encodeURIComponent(serverId)}/rotate-credentials`,
        body,
      ),
    onSuccess: invalidate,
  });
}
