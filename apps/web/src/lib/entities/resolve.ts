import type {
  AccessKey,
  Bucket,
  Job,
  PolicySummary,
  S3Group,
  S3User,
  Server,
} from '@storage-io/contracts';
import {
  useQuery,
  type QueryClient,
  type QueryKey,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * The one place an opaque route id becomes a real entity.
 *
 * Every URL in the app carries ids (docs/ROUTES.md rule 1) while every per-server
 * API endpoint is addressed by `serverId` + *name*. Turning one into the other is
 * something a dozen pages, the breadcrumbs and the page titles all need, and doing
 * it per page is how a UUID ends up rendered as a bucket name in one of them.
 *
 * What is cached here is deliberately only the **reference** — id, server, name —
 * and not the entity's contents. Each page still loads its own detail with its own
 * hook, so nothing here goes stale in a way a page would show; and because a ref is
 * a subset of every list row, any list the operator has already seen can seed it
 * (`seedEntities`). Arriving from a list therefore costs no request, and only a
 * deep link actually calls the resolve endpoint.
 */

export const ENTITY_KINDS = ['server', 'bucket', 'user', 'group', 'policy', 'key', 'job'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** What every page needs from an id: which server it lives on, and its name. */
export interface EntityRef {
  readonly id: string;
  /** `null` for entities that are not per-server: a server itself, and a job. */
  readonly serverId: string | null;
  readonly name: string;
}

/** The shapes a ref can be read from — a list row and a resolve response alike. */
type EntitySource =
  | Server
  | Bucket
  | S3User
  | S3Group
  | PolicySummary
  | AccessKey
  | Job
  | { readonly id: string; readonly serverId?: string; readonly name?: string | null };

interface Resolver {
  readonly path: (id: string) => string;
  readonly toRef: (value: EntitySource) => EntityRef;
}

function serverSideRef(value: EntitySource): EntityRef {
  const source = value as { id: string; serverId: string; name: string };
  return { id: source.id, serverId: source.serverId, name: source.name };
}

function standaloneRef(value: EntitySource): EntityRef {
  const source = value as { id: string; name: string };
  return { id: source.id, serverId: null, name: source.name };
}

/**
 * A key's display name is optional and its access key id never is, so the access
 * key id is the fallback — never the UUID, which is exactly what a breadcrumb must
 * not show.
 */
function accessKeyRef(value: EntitySource): EntityRef {
  const source = value as AccessKey;
  return { id: source.id, serverId: source.serverId, name: source.name ?? source.accessKeyId };
}

function serverRef(value: EntitySource): EntityRef {
  const source = value as Server;
  return { id: source.id, serverId: source.id, name: source.name };
}

const RESOLVERS: Readonly<Record<EntityKind, Resolver>> = {
  server: { path: (id) => `/servers/${encodeURIComponent(id)}`, toRef: serverRef },
  bucket: { path: (id) => `/buckets/${encodeURIComponent(id)}`, toRef: serverSideRef },
  user: { path: (id) => `/iam/users/${encodeURIComponent(id)}`, toRef: serverSideRef },
  group: { path: (id) => `/iam/groups/${encodeURIComponent(id)}`, toRef: serverSideRef },
  policy: { path: (id) => `/iam/policies/${encodeURIComponent(id)}`, toRef: serverSideRef },
  key: { path: (id) => `/iam/access-keys/${encodeURIComponent(id)}`, toRef: accessKeyRef },
  job: { path: (id) => `/jobs/${encodeURIComponent(id)}`, toRef: standaloneRef },
};

function refKey(kind: EntityKind, id: string): QueryKey {
  return queryKeys.entities.ref(kind, id);
}

/**
 * An id names the same entity for as long as the page is open — the registry
 * assigns it once and never reassigns it — so this is deliberately long lived.
 */
const RESOLVE_STALE_MS = 5 * 60_000;

/** The entity an opaque route id names, resolved once and shared. */
export function useEntityRef(
  kind: EntityKind,
  id: string | undefined,
): UseQueryResult<EntityRef> {
  const resolver = RESOLVERS[kind];
  const safeId = id ?? '';
  return useQuery<EntityRef>({
    queryKey: refKey(kind, safeId),
    queryFn: async ({ signal }) => {
      const entity = await api.get<EntitySource>(resolver.path(safeId), undefined, signal);
      return resolver.toRef(entity);
    },
    enabled: id !== undefined && id !== '',
    staleTime: RESOLVE_STALE_MS,
    retry: false,
  });
}

/**
 * The display name behind an id, or `null` while it is unknown.
 *
 * The breadcrumbs and the document title call this: a caller that only needs the
 * name should never have to know which endpoint answers for which kind.
 */
export function useEntityName(kind: EntityKind, id: string | undefined): string | null {
  const query = useEntityRef(kind, id);
  return query.data?.name ?? null;
}

/**
 * Seeds the ref cache from a list that already carries the entities, so clicking a
 * row costs no request. Existing entries are left alone: a list row and a resolve
 * response agree on id, server and name, and overwriting would only churn.
 */
export function seedEntities(
  client: QueryClient,
  kind: EntityKind,
  items: readonly EntitySource[] | undefined,
): void {
  if (items === undefined) return;
  const resolver = RESOLVERS[kind];
  for (const item of items) {
    const ref = resolver.toRef(item);
    const key = refKey(kind, ref.id);
    if (client.getQueryData(key) !== undefined) continue;
    client.setQueryData(key, ref);
  }
}

/**
 * What the per-server bucket endpoints need, from the id the URL carries.
 *
 * Every bucket page starts here: resolve once, then call
 * `/servers/:serverId/buckets/:name/...` with the result. `scope` is `null` until
 * the id has resolved, and every bucket query keys off it, so nothing fires
 * against a half-known bucket.
 */
export interface BucketScope {
  readonly serverId: string;
  readonly bucket: string;
}

export function useBucketScope(bucketId: string | undefined): {
  readonly scope: BucketScope | null;
  readonly name: string | null;
  readonly isLoading: boolean;
  readonly error: unknown;
} {
  const query = useEntityRef('bucket', bucketId);
  const ref = query.data;
  const serverId = ref?.serverId ?? null;
  const name = ref?.name ?? null;
  // A stable object: every bucket query keys off it, and a fresh one per render
  // would be a fresh query key per render.
  const scope = useMemo(
    () => (serverId === null || name === null ? null : { serverId, bucket: name }),
    [serverId, name],
  );
  return { scope, name, isLoading: query.isLoading, error: query.error };
}
