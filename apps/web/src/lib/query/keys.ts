/**
 * The one place a query key is spelled.
 *
 * Every key starts with a scope string, so `invalidateQueries({ queryKey:
 * queryKeys.servers.all })` invalidates every server query including the
 * detail ones. `useEventStream` relies on exactly that: one SSE event
 * invalidates a whole scope without listing its members.
 *
 * Rule: a list key carries its filters object, so two different filters are two
 * different cache entries. Never build a key inline in a component.
 */
export const queryKeys = {
  auth: {
    all: ['auth'] as const,
    me: () => [...queryKeys.auth.all, 'me'] as const,
    sessions: () => [...queryKeys.auth.all, 'sessions'] as const,
    tokens: () => [...queryKeys.auth.all, 'tokens'] as const,
  },
  servers: {
    all: ['servers'] as const,
    list: (filters?: unknown) => [...queryKeys.servers.all, 'list', filters ?? null] as const,
    detail: (serverId: string) => [...queryKeys.servers.all, 'detail', serverId] as const,
    metrics: (serverId: string, range: string) =>
      [...queryKeys.servers.all, 'metrics', serverId, range] as const,
    nodes: (serverId: string) => [...queryKeys.servers.all, 'nodes', serverId] as const,
    drives: (serverId: string, node: string) =>
      [...queryKeys.servers.all, 'nodes', serverId, node, 'drives'] as const,
    events: (serverId: string, limit?: number) =>
      [...queryKeys.servers.all, 'events', serverId, limit ?? null] as const,
  },
  buckets: {
    all: ['buckets'] as const,
    list: (filters?: unknown) => [...queryKeys.buckets.all, 'list', filters ?? null] as const,
    detail: (serverId: string, bucket: string) =>
      [...queryKeys.buckets.all, 'detail', serverId, bucket] as const,

    /** `section` is the sub-resource: 'policy', 'lifecycle', 'cors', 'quota', … */
    section: (serverId: string, bucket: string, section: string) =>
      [...queryKeys.buckets.all, 'detail', serverId, bucket, section] as const,
  },
  objects: {
    all: ['objects'] as const,
    list: (serverId: string, bucket: string, filters?: unknown) =>
      [...queryKeys.objects.all, 'list', serverId, bucket, filters ?? null] as const,
    meta: (serverId: string, bucket: string, key: string, versionId?: string) =>
      [...queryKeys.objects.all, 'meta', serverId, bucket, key, versionId ?? null] as const,
    versions: (serverId: string, bucket: string, key: string) =>
      [...queryKeys.objects.all, 'versions', serverId, bucket, key] as const,
    archiveEntries: (serverId: string, bucket: string, key: string, versionId?: string) =>
      [
        ...queryKeys.objects.all,
        'archive-entries',
        serverId,
        bucket,
        key,
        versionId ?? null,
      ] as const,
  },
  iam: {
    all: ['iam'] as const,
    users: (filters?: unknown) => [...queryKeys.iam.all, 'users', filters ?? null] as const,
    user: (serverId: string, name: string) =>
      [...queryKeys.iam.all, 'user', serverId, name] as const,
    groups: (filters?: unknown) => [...queryKeys.iam.all, 'groups', filters ?? null] as const,
    policies: (filters?: unknown) => [...queryKeys.iam.all, 'policies', filters ?? null] as const,
    policy: (serverId: string, name: string) =>
      [...queryKeys.iam.all, 'policy', serverId, name] as const,
    policyVersions: (serverId: string, name: string) =>
      [...queryKeys.iam.all, 'policy', serverId, name, 'versions'] as const,
    accessKeys: (filters?: unknown) =>
      [...queryKeys.iam.all, 'access-keys', filters ?? null] as const,

  },
  quotas: {
    all: ['quotas'] as const,
    list: (filters?: unknown) => [...queryKeys.quotas.all, 'list', filters ?? null] as const,
  },
  jobs: {
    all: ['jobs'] as const,
    list: (filters?: unknown) => [...queryKeys.jobs.all, 'list', filters ?? null] as const,
    detail: (jobId: string) => [...queryKeys.jobs.all, 'detail', jobId] as const,
    logs: (jobId: string, level?: string) =>
      [...queryKeys.jobs.all, 'logs', jobId, level ?? null] as const,
    runs: (jobId: string, page?: number) =>
      [...queryKeys.jobs.all, 'runs', jobId, page ?? null] as const,
  },
  activity: {
    all: ['activity'] as const,
    list: (filters?: unknown) => [...queryKeys.activity.all, 'list', filters ?? null] as const,
    detail: (id: string) => [...queryKeys.activity.all, 'detail', id] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    list: (unreadOnly?: boolean) =>
      [...queryKeys.notifications.all, 'list', unreadOnly ?? null] as const,
  },
  dashboard: {
    all: ['dashboard'] as const,
    overview: () => [...queryKeys.dashboard.all, 'overview'] as const,
  },
  search: {
    all: ['search'] as const,
    query: (term: string) => [...queryKeys.search.all, term] as const,
  },
  settings: {
    all: ['settings'] as const,
    current: () => [...queryKeys.settings.all, 'current'] as const,
  },
  health: {
    all: ['health'] as const,
  },
  /**
   * The opaque ids the URLs carry, resolved to `{ id, serverId, name }`.
   * Its own scope, because an id never changes meaning: nothing on the stream
   * makes a ref stale, and invalidating `buckets` must not throw it away.
   */
  entities: {
    all: ['entities'] as const,
    /** `{ id, serverId, name }` — what a breadcrumb and a route need. */
    ref: (kind: string, id: string) => [...queryKeys.entities.all, kind, id] as const,
    /** The whole entity the resolve endpoint returns, for the page that renders it. */
    byId: (kind: string, id: string) => [...queryKeys.entities.all, kind, id, 'full'] as const,
  },
} as const;

/** Every top-level scope, for the "invalidate everything for this event" paths. */
export const QUERY_SCOPES = {
  auth: queryKeys.auth.all,
  servers: queryKeys.servers.all,
  buckets: queryKeys.buckets.all,
  objects: queryKeys.objects.all,
  iam: queryKeys.iam.all,
  quotas: queryKeys.quotas.all,
  jobs: queryKeys.jobs.all,
  activity: queryKeys.activity.all,
  notifications: queryKeys.notifications.all,
  dashboard: queryKeys.dashboard.all,
  search: queryKeys.search.all,
  settings: queryKeys.settings.all,
} as const;
