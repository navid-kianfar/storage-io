import {
  API_PREFIX,
  CAPABILITIES,
  PROVIDER_IAM_DRIVERS,
  type AccessKey,
  type ActivityEvent,
  type Bucket,
  type CapabilityMap,
  type CheckResult,
  type Dashboard,
  type Provider,
  type QuotaList,
  type QuotaRow,
  type S3User,
  type S3UserList,
  type Server,
  type ServerDriveList,
  type ServerHealthEventList,
  type ServerMetrics,
  type ServerNodeList,
  type TestServerResponse,
} from '@storage-io/contracts';
import { HttpResponse, http } from 'msw';
import { allBuckets } from './bucketState';
import { mockDashboard, mockServers } from './fixtures';
import { accessKeyId as mintKeyId, iamUserId } from './ids';

/**
 * Mock handlers for the endpoints the overview, first-run, servers, server detail
 * and quotas pages need but that apps/api has not implemented yet (`/dashboard`,
 * `/quotas`, `/buckets`, `/iam/users`, `/servers/:id/rotate-credentials`).
 *
 * They are **stateful** on purpose: adding a server, removing one and toggling
 * maintenance all change what the next request returns, so a flow can be
 * exercised end to end in `pnpm dev:mock` rather than only looked at.
 *
 * Buckets are **not** duplicated here: `/buckets`, every bucket sub-resource and
 * the quota write belong to `bucketHandlers.ts`, and `/quotas` and `/dashboard`
 * read the same `bucketState` inventory. Two copies meant a quota saved through
 * the dialog never reached this page — found in the browser, fixed here.
 *
 * Spread before the generic handlers in `handlers.ts`: MSW answers with the first
 * match, and the stateful `/servers` list has to win over the static one.
 */

const base = API_PREFIX;

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_ACCEPTED = 202;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;

function isoAgo(milliseconds: number): string {
  return new Date(Date.now() - milliseconds).toISOString();
}

function isoIn(milliseconds: number): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

function problem(status: number, code: string, detail: string) {
  return HttpResponse.json(
    { type: 'about:blank', title: code, status, detail, code },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/* ----------------------------- capabilities ---------------------------- */

/** What each provider's driver can do, so the matrix and the gating are truthful. */
function capabilitiesFor(provider: Provider): CapabilityMap {
  const iam = PROVIDER_IAM_DRIVERS[provider] !== 'none';
  const nativeQuota = provider === 'minio' || provider === 'seaweedfs' || provider === 'ceph' || provider === 'garage';
  const map = Object.fromEntries(
    CAPABILITIES.map((name) => {
      switch (name) {
        case 'objects':
        case 'versioning':
        case 'tagging':
        case 'bucketPolicy':
        case 'usageStats':
          return [name, 'supported'];
        case 'objectLock':
        case 'lifecycle':
        case 'cors':
          return [name, provider === 'generic' ? 'not_supported' : 'supported'];
        case 'replication':
        case 'notifications':
        case 'encryption':
          return [name, 'not_configured'];
        case 'storageClasses':
          return [name, provider === 'aws' ? 'supported' : 'not_supported'];
        case 'iamUsers':
        case 'iamGroups':
        case 'iamPolicies':
        case 'accessKeys':
          return [name, iam ? 'supported' : 'not_supported'];
        case 'accessKeyExpiry':
          return [name, provider === 'minio' ? 'supported' : 'not_supported'];
        case 'bucketQuota':
          return [name, nativeQuota ? 'supported' : 'not_supported'];
        case 'nodes':
          return [name, provider === 'minio' ? 'supported' : 'not_supported'];
        case 'traffic':
          return [name, provider === 'minio' ? 'not_configured' : 'not_supported'];
      }
    }),
  ) as CapabilityMap;
  return map;
}

/* -------------------------------- store -------------------------------- */

const servers: Server[] = mockServers.map((entry) => ({
  ...entry,
  capabilities: capabilitiesFor(entry.provider),
}));

function findServer(id: string): Server | undefined {
  return servers.find((entry) => entry.id === id || entry.name === id);
}

/* ------------------------------ extra data ----------------------------- */

const activity: readonly ActivityEvent[] = [
  {
    id: 'a1',
    at: isoAgo(4 * MINUTE_MS),
    category: 'objects',
    action: 'object.upload',
    title: 'Objects uploaded',
    actor: { type: 'admin', name: 'admin' },
    target: 'media-prod/2026/09/',
    serverId: servers[0]!.id,
    serverName: 'minio-prod-01',
    ip: '10.0.0.4',
    result: 'success',
    requestId: 'req-8812',
    details: { objects: 128 },
  },
  {
    id: 'a2',
    at: isoAgo(38 * MINUTE_MS),
    category: 'access',
    action: 'accessKey.rotate',
    title: 'Access key rotated',
    actor: { type: 'admin', name: 'admin' },
    target: 'ci-deployer',
    serverId: servers[0]!.id,
    serverName: 'minio-prod-01',
    ip: '10.0.0.4',
    result: 'success',
    requestId: 'req-8730',
    details: {},
  },
  {
    id: 'a3',
    at: isoAgo(2 * HOUR_MS),
    category: 'buckets',
    action: 'bucket.policy.update',
    title: 'Bucket policy updated',
    actor: { type: 'admin', name: 'admin' },
    target: 'public-assets',
    serverId: servers[0]!.id,
    serverName: 'minio-prod-01',
    ip: '10.0.0.4',
    result: 'success',
    requestId: 'req-8611',
    details: { access: 'public-read' },
  },
  {
    id: 'a4',
    at: isoAgo(3 * HOUR_MS),
    category: 'servers',
    action: 'server.latency',
    title: 'High latency detected',
    actor: { type: 'system', name: 'health-checker' },
    target: '184 ms',
    serverId: servers[3]!.id,
    serverName: 'ceph-lab',
    ip: null,
    result: 'warning',
    requestId: null,
    details: { latencyMs: 184 },
  },
  {
    id: 'a5',
    at: isoAgo(5 * HOUR_MS),
    category: 'jobs',
    action: 'job.completed',
    title: 'Bulk job completed',
    actor: { type: 'system', name: 'job-engine' },
    target: 'Archive 2025 logs',
    serverId: servers[0]!.id,
    serverName: 'minio-prod-01',
    ip: null,
    result: 'success',
    requestId: null,
    details: { objects: 1_200_000 },
  },
  {
    id: 'a6',
    at: isoAgo(DAY_MS),
    category: 'buckets',
    action: 'bucket.create',
    title: 'Bucket created',
    actor: { type: 'admin', name: 'admin' },
    target: 'ml-datasets',
    serverId: servers[3]!.id,
    serverName: 'ceph-lab',
    ip: '10.0.0.4',
    result: 'success',
    requestId: 'req-8120',
    details: {},
  },
];

const expiringKeys: readonly AccessKey[] = [
  {
    id: mintKeyId(servers[0]!.id, 'AKIA5RJ2QK4LMNOPQ7F2'),
    serverId: servers[0]!.id,
    serverName: 'minio-prod-01',
    provider: 'minio',
    accessKeyId: 'AKIA5RJ2QK4LMNOPQ7F2',
    userName: 'backup-agent',
    name: 'backup-agent',
    status: 'active',
    restricted: false,
    createdAt: isoAgo(200 * DAY_MS),
    expiresAt: isoIn(3 * DAY_MS),
    lastUsedAt: isoAgo(HOUR_MS),
    rotation: null,
  },
  {
    id: mintKeyId(servers[0]!.id, 'SIO3K8QW2LZXM81C'),
    serverId: servers[0]!.id,
    serverName: 'minio-prod-01',
    provider: 'minio',
    accessKeyId: 'SIO3K8QW2LZXM81C',
    userName: 'ci-deployer',
    name: 'ci-deployer',
    status: 'active',
    restricted: true,
    createdAt: isoAgo(90 * DAY_MS),
    expiresAt: isoIn(12 * DAY_MS),
    lastUsedAt: isoAgo(15 * MINUTE_MS),
    rotation: null,
  },
  {
    id: mintKeyId(servers[1]!.id, 'SIO9PLM4RT2KDA'),
    serverId: servers[1]!.id,
    serverName: 'seaweed-archive',
    provider: 'seaweedfs',
    accessKeyId: 'SIO9PLM4RT2KDA',
    userName: 'analytics-ro',
    name: 'analytics-ro',
    status: 'active',
    restricted: false,
    createdAt: isoAgo(140 * DAY_MS),
    expiresAt: isoIn(27 * DAY_MS),
    lastUsedAt: isoAgo(6 * HOUR_MS),
    rotation: null,
  },
];

const iamUsers: readonly S3User[] = [
  ['ci-deployer', ['ci-artifacts-rw'], 2, 'enabled', 15 * MINUTE_MS],
  ['media-uploader', ['media-uploader'], 1, 'enabled', 4 * MINUTE_MS],
  ['svc-thumbnails', ['readwrite'], 1, 'enabled', MINUTE_MS],
  ['app-staging', ['readonly'], 3, 'enabled', DAY_MS],
  ['readonly-audit', ['diagnostics'], 0, 'disabled', null],
].map(([name, policies, keys, status, lastUsed]) => ({
  id: iamUserId(servers[0]!.id, name as string),
  serverId: servers[0]!.id,
  serverName: 'minio-prod-01',
  provider: 'minio' as const,
  name: name as string,
  status: status as S3User['status'],
  policies: policies as string[],
  groups: [],
  accessKeyCount: keys as number,
  createdAt: isoAgo(120 * DAY_MS),
  lastActivityAt: lastUsed === null ? null : isoAgo(lastUsed as number),
}));

/* ------------------------------- checks -------------------------------- */

function checksFor(provider: Provider): readonly CheckResult[] {
  const iam = PROVIDER_IAM_DRIVERS[provider] !== 'none';
  return [
    { id: 'dns', label: 'DNS & TCP reachability', status: 'ok', detail: '4 ms', durationMs: 4 },
    {
      id: 'tls',
      label: 'TLS certificate',
      status: 'ok',
      detail: 'valid · 214 days left',
      durationMs: 22,
    },
    { id: 'auth', label: 'Authenticate', status: 'ok', detail: 'sio-admin', durationMs: 31 },
    { id: 'listBuckets', label: 'List buckets', status: 'ok', detail: '42 buckets', durationMs: 48 },
    {
      id: 'admin',
      label: 'Admin API',
      status: iam ? 'ok' : 'skipped',
      detail: iam ? 'reachable' : 'this provider has no admin API',
      durationMs: iam ? 54 : 0,
    },
    {
      id: 'versioning',
      label: 'Versioning & object lock',
      status: 'ok',
      detail: 'supported',
      durationMs: 18,
    },
    {
      id: 'replication',
      label: 'Bucket replication',
      status: 'warn',
      detail: 'not configured',
      durationMs: 12,
    },
  ];
}

function testResponse(provider: Provider): TestServerResponse {
  return {
    checks: [...checksFor(provider)],
    capabilities: capabilitiesFor(provider),
    version: provider === 'minio' ? 'RELEASE.2026-08-14' : null,
    bucketCount: 42,
  };
}

/* ------------------------------- metrics ------------------------------- */

const METRIC_POINTS: Readonly<Record<string, number>> = { '24h': 48, '7d': 84, '30d': 120 };

function metricsFor(server: Server, range: string): ServerMetrics {
  const points = METRIC_POINTS[range] ?? METRIC_POINTS['24h']!;
  const spanMs = range === '30d' ? 30 * DAY_MS : range === '7d' ? 7 * DAY_MS : DAY_MS;
  const stepMs = spanMs / points;
  const baseLatency = server.latencyMs ?? 20;
  const used = server.capacity.usedBytes ?? 0;
  return {
    capacity: Array.from({ length: points }, (_unused, index) => ({
      t: isoAgo(spanMs - index * stepMs),
      usedBytes: used * (0.88 + (0.12 * index) / points),
      totalBytes: server.capacity.totalBytes,
    })),
    // `traffic` is a Prometheus-style series the mock has no source for; `null`
    // is the contract's "this server cannot report it", which is the truthful
    // answer here rather than an invented rate.
    traffic: null,
    latency: Array.from({ length: points }, (_unused, index) => ({
      t: isoAgo(spanMs - index * stepMs),
      // A deterministic wobble: a random series would jump on every refetch.
      ms: Math.max(1, baseLatency + Math.round(6 * Math.sin(index / 3) + 3 * Math.cos(index / 7))),
    })),
    uptime: server.uptime24h ?? 1,
  };
}

const NODES: ServerNodeList = {
  items: [
    { name: 'node-1', endpoint: '10.20.4.11', state: 'online', drivesOnline: 4, drivesTotal: 4, uptimeSec: 41 * 86_400, cpu: 0.38, mem: 0.61, usedBytes: 2.2e12, totalBytes: 3e12 },
    { name: 'node-2', endpoint: '10.20.4.12', state: 'online', drivesOnline: 4, drivesTotal: 4, uptimeSec: 41 * 86_400, cpu: 0.44, mem: 0.58, usedBytes: 2.1e12, totalBytes: 3e12 },
    { name: 'node-3', endpoint: '10.20.4.13', state: 'degraded', drivesOnline: 3, drivesTotal: 4, uptimeSec: 6 * 86_400, cpu: 0.71, mem: 0.74, usedBytes: 2.2e12, totalBytes: 3e12 },
    { name: 'node-4', endpoint: '10.20.4.14', state: 'online', drivesOnline: 4, drivesTotal: 4, uptimeSec: 41 * 86_400, cpu: 0.35, mem: 0.55, usedBytes: 2.1e12, totalBytes: 3e12 },
  ],
};

function drivesFor(node: string): ServerDriveList {
  const offline = node === 'node-3';
  return {
    items: Array.from({ length: 4 }, (_unused, index) => ({
      path: `/data/disk${index + 1}`,
      state: offline && index === 3 ? 'offline' : 'ok',
      usedBytes: offline && index === 3 ? null : 0.55e12,
      totalBytes: offline && index === 3 ? null : 0.75e12,
      model: 'SEAGATE ST16000NM',
      healing: offline && index === 3,
    })),
  };
}

const HEALTH_EVENTS: ServerHealthEventList = {
  items: [
    { at: isoAgo(25_000), kind: 'check', detail: '12 ms · 42 buckets' },
    { at: isoAgo(2 * HOUR_MS), kind: 'degraded', detail: 'node-3 · /data/disk4' },
    { at: isoAgo(12 * HOUR_MS), kind: 'latency', detail: '184 ms for 40 s' },
    { at: isoAgo(41 * DAY_MS), kind: 'up', detail: 'RELEASE.2026-08-14' },
  ],
};

/* -------------------------------- quotas ------------------------------- */

function quotaRowOf(bucket: Bucket): QuotaRow {
  const native =
    bucket.provider === 'minio' ||
    bucket.provider === 'seaweedfs' ||
    bucket.provider === 'ceph' ||
    bucket.provider === 'garage';
  const supported = bucket.unavailable ? 'unavailable' : native ? 'native' : 'alert-only';
  const ratio =
    bucket.quota === null || bucket.sizeBytes === null || bucket.quota.limitBytes === 0
      ? null
      : bucket.sizeBytes / bucket.quota.limitBytes;
  const size = bucket.sizeBytes ?? 0;
  return {
    bucket,
    usageRatio: ratio,
    // Seven daily sizes ending at today's, so the sparkline has a real slope.
    trend: Array.from({ length: 7 }, (_unused, index) => size * (0.9 + (0.1 * index) / 6)),
    supported,
  };
}

function quotaList(): QuotaList {
  const items = allBuckets().map((entry) => quotaRowOf(entry.bucket));
  const withQuota = items.filter((row) => row.bucket.quota !== null);
  return {
    items,
    total: items.length,
    summary: {
      withQuota: withQuota.length,
      over90: withQuota.filter((row) => (row.usageRatio ?? 0) >= 0.9).length,
      over80: withQuota.filter((row) => (row.usageRatio ?? 0) >= 0.8).length,
      unlimited: items.length - withQuota.length,
    },
  };
}

/* ------------------------------ dashboard ------------------------------ */

function dashboard(): Dashboard {
  const totals = servers.reduce(
    (accumulator, server) => ({
      used: accumulator.used + (server.capacity.usedBytes ?? 0),
      capacity: accumulator.capacity + (server.capacity.totalBytes ?? 0),
      buckets: accumulator.buckets + server.counts.buckets,
      objects: accumulator.objects + (server.counts.objects ?? 0),
      users: accumulator.users + (server.counts.users ?? 0),
    }),
    { used: 0, capacity: 0, buckets: 0, objects: 0, users: 0 },
  );
  const quotas = quotaList();
  return {
    ...mockDashboard,
    totals: {
      ...mockDashboard.totals,
      bucketsBytes: totals.used,
      capacityBytes: totals.capacity,
      buckets: totals.buckets,
      objects: totals.objects,
      users: totals.users,
      accessKeys: 61,
      servers: {
        total: servers.length,
        healthy: servers.filter((entry) => entry.status === 'healthy').length,
        degraded: servers.filter((entry) => entry.status === 'degraded').length,
        offline: servers.filter((entry) => entry.status === 'offline').length,
      },
      nearQuotaBuckets: quotas.summary.over80,
    },
    byServer: servers.map((entry) => ({
      serverId: entry.id,
      name: entry.name,
      provider: entry.provider,
      usedBytes: entry.capacity.usedBytes ?? 0,
      totalBytes: entry.capacity.totalBytes,
    })),
    activity: [...activity],
    expiringKeys: [...expiringKeys],
    largestBuckets: allBuckets()
      .map((entry) => entry.bucket)
      .toSorted((left, right) => (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0))
      .slice(0, 5),
    incidents: servers
      .filter((entry) => entry.status === 'offline' || entry.status === 'degraded')
      .map((entry) => ({
        serverId: entry.id,
        serverName: entry.name,
        status: entry.status,
        detail: entry.statusDetail,
        since: entry.lastSeenAt ?? isoAgo(HOUR_MS),
      })),
  };
}

/* ------------------------------- handlers ------------------------------ */

interface ConnectionBody {
  readonly name?: string;
  readonly provider?: Provider;
  readonly endpoint?: string;
  readonly region?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly options?: Partial<Server['options']>;
}

function paginate<T>(items: readonly T[], url: URL): { readonly page: readonly T[]; readonly total: number } {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '50');
  const start = (page - 1) * pageSize;
  return { page: items.slice(start, start + pageSize), total: items.length };
}

export const pageHandlers = [
  /* ---- servers: the stateful list wins over the static one ---- */
  http.get(`${base}/servers`, ({ request }) => {
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const provider = url.searchParams.get('provider');
    const status = url.searchParams.get('status');
    const items = servers.filter(
      (entry) =>
        (query === '' ||
          entry.name.toLowerCase().includes(query) ||
          entry.endpoint.toLowerCase().includes(query)) &&
        (provider === null || entry.provider === provider) &&
        (status === null || entry.status === status),
    );
    return HttpResponse.json({ items, total: items.length });
  }),

  http.post(`${base}/servers/test`, async ({ request }) => {
    const body = (await request.json()) as ConnectionBody;
    if (body.endpoint !== undefined && body.endpoint.includes('unreachable')) {
      return HttpResponse.json({
        ...testResponse(body.provider ?? 'generic'),
        checks: [
          {
            id: 'dns',
            label: 'DNS & TCP reachability',
            status: 'fail',
            detail: 'Connection refused',
            durationMs: 2003,
          },
        ],
      } satisfies TestServerResponse);
    }
    return HttpResponse.json(testResponse(body.provider ?? 'generic'));
  }),

  http.post(`${base}/servers/check-all`, () => new HttpResponse(null, { status: HTTP_ACCEPTED })),

  http.post(`${base}/servers`, async ({ request }) => {
    const body = (await request.json()) as ConnectionBody;
    const name = body.name ?? 'new-server';
    if (servers.some((entry) => entry.name === name)) {
      return problem(HTTP_CONFLICT, 'CONFLICT', `A server called ${name} already exists.`);
    }
    const provider = body.provider ?? 'generic';
    const created: Server = {
      id: crypto.randomUUID(),
      name,
      provider,
      endpoint: body.endpoint ?? '',
      region: body.region ?? 'us-east-1',
      status: 'healthy',
      statusDetail: null,
      latencyMs: 14,
      lastCheckedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      version: provider === 'minio' ? 'RELEASE.2026-08-14' : null,
      uptime24h: 1,
      capacity: { usedBytes: 0, totalBytes: null, budget: false },
      counts: { buckets: 42, users: PROVIDER_IAM_DRIVERS[provider] === 'none' ? null : 0, objects: 0 },
      capabilities: capabilitiesFor(provider),
      options: {
        pathStyle: true,
        tlsVerify: true,
        caPem: null,
        adminEndpoint: null,
        iamEndpoint: null,
        healthIntervalSec: 30,
        ...(body.options ?? {}),
      },
      accessKeyId: body.accessKeyId ?? 'sio-admin',
      secretMasked: '••••K7MD',
      maintenance: false,
      tls: (body.endpoint ?? '').startsWith('https://'),
      createdAt: new Date().toISOString(),
    };
    servers.push(created);
    return HttpResponse.json(created, { status: HTTP_CREATED });
  }),

  http.get(`${base}/servers/:id`, ({ params }) => {
    const server = findServer(String(params.id));
    return server === undefined
      ? problem(HTTP_NOT_FOUND, 'NOT_FOUND', 'No such server.')
      : HttpResponse.json(server);
  }),

  http.patch(`${base}/servers/:id`, async ({ params, request }) => {
    const server = findServer(String(params.id));
    if (server === undefined) return problem(HTTP_NOT_FOUND, 'NOT_FOUND', 'No such server.');
    const body = (await request.json()) as ConnectionBody;
    Object.assign(server, {
      name: body.name ?? server.name,
      endpoint: body.endpoint ?? server.endpoint,
      region: body.region ?? server.region,
      accessKeyId: body.accessKeyId ?? server.accessKeyId,
      options: { ...server.options, ...(body.options ?? {}) },
      tls: (body.endpoint ?? server.endpoint).startsWith('https://'),
      lastCheckedAt: new Date().toISOString(),
    });
    return HttpResponse.json(server);
  }),

  http.delete(`${base}/servers/:id`, ({ params }) => {
    const index = servers.findIndex(
      (entry) => entry.id === String(params.id) || entry.name === String(params.id),
    );
    if (index === -1) return problem(HTTP_NOT_FOUND, 'NOT_FOUND', 'No such server.');
    servers.splice(index, 1);
    return new HttpResponse(null, { status: HTTP_NO_CONTENT });
  }),

  http.post(`${base}/servers/:id/test`, ({ params }) => {
    const server = findServer(String(params.id));
    if (server === undefined) return problem(HTTP_NOT_FOUND, 'NOT_FOUND', 'No such server.');
    if (server.status === 'offline') {
      return HttpResponse.json({
        checks: [
          {
            id: 'dns',
            label: 'DNS & TCP reachability',
            status: 'fail',
            detail: server.statusDetail ?? 'Connection refused',
            durationMs: 2001,
          },
        ],
        capabilities: server.capabilities,
        version: server.version,
        bucketCount: null,
      } satisfies TestServerResponse);
    }
    return HttpResponse.json(testResponse(server.provider));
  }),

  http.post(`${base}/servers/:id/check`, ({ params }) => {
    const server = findServer(String(params.id));
    if (server === undefined) return problem(HTTP_NOT_FOUND, 'NOT_FOUND', 'No such server.');
    server.lastCheckedAt = new Date().toISOString();
    if (server.status !== 'offline') server.lastSeenAt = server.lastCheckedAt;
    return HttpResponse.json(server);
  }),

  http.put(`${base}/servers/:id/maintenance`, async ({ params, request }) => {
    const server = findServer(String(params.id));
    if (server === undefined) return problem(HTTP_NOT_FOUND, 'NOT_FOUND', 'No such server.');
    const body = (await request.json()) as { readonly enabled: boolean };
    server.maintenance = body.enabled;
    server.status = body.enabled ? 'maintenance' : 'healthy';
    return HttpResponse.json(server);
  }),

  http.post(`${base}/servers/:id/rotate-credentials`, async ({ params, request }) => {
    const server = findServer(String(params.id));
    if (server === undefined) return problem(HTTP_NOT_FOUND, 'NOT_FOUND', 'No such server.');
    const body = (await request.json()) as {
      readonly mode: 'auto' | 'manual';
      readonly accessKeyId?: string;
    };
    server.accessKeyId =
      body.mode === 'manual' ? (body.accessKeyId ?? server.accessKeyId) : `${server.accessKeyId}-2`;
    server.secretMasked = '••••9F2A';
    return HttpResponse.json({ server, rotatedAt: new Date().toISOString() });
  }),

  http.get(`${base}/servers/:id/metrics`, ({ params, request }) => {
    const server = findServer(String(params.id));
    if (server === undefined) return problem(HTTP_NOT_FOUND, 'NOT_FOUND', 'No such server.');
    const range = new URL(request.url).searchParams.get('range') ?? '24h';
    return HttpResponse.json(metricsFor(server, range));
  }),

  http.get(`${base}/servers/:id/nodes`, ({ params }) => {
    const server = findServer(String(params.id));
    if (server === undefined) return problem(HTTP_NOT_FOUND, 'NOT_FOUND', 'No such server.');
    if (server.capabilities.nodes !== 'supported') {
      return problem(
        HTTP_CONFLICT,
        'NOT_SUPPORTED',
        'This provider does not expose a node topology.',
      );
    }
    return HttpResponse.json(NODES);
  }),

  http.get(`${base}/servers/:id/nodes/:node/drives`, ({ params }) =>
    HttpResponse.json(drivesFor(String(params.node))),
  ),

  http.get(`${base}/servers/:id/events`, () => HttpResponse.json(HEALTH_EVENTS)),

  /* ---- quotas ---- */
  http.get(`${base}/quotas`, ({ request }) => {
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const serverId = url.searchParams.get('serverId');
    const filter = url.searchParams.get('filter') ?? 'all';
    const list = quotaList();
    const matching = list.items.filter((row) => {
      if (query !== '' && !row.bucket.name.toLowerCase().includes(query)) return false;
      if (serverId !== null && row.bucket.serverId !== serverId) return false;
      if (filter === 'near') return (row.usageRatio ?? 0) >= 0.8;
      if (filter === 'unlimited') return row.bucket.quota === null;
      return true;
    });
    const { page, total } = paginate(matching, url);
    return HttpResponse.json({ items: page, total, summary: list.summary });
  }),

  /* ---- IAM users, per server ---- */
  http.get(`${base}/iam/users`, ({ request }) => {
    const url = new URL(request.url);
    const serverId = url.searchParams.get('serverId');
    const server = serverId === null ? undefined : findServer(serverId);
    if (server !== undefined && server.capabilities.iamUsers !== 'supported') {
      return problem(HTTP_CONFLICT, 'NOT_SUPPORTED', 'This provider has no IAM driver.');
    }
    const matching = iamUsers.filter(
      (user) => serverId === null || user.serverId === serverId || user.serverName === serverId,
    );
    const { page, total } = paginate(matching, url);
    const response: S3UserList = { items: [...page], total, unavailable: [] };
    return HttpResponse.json(response);
  }),

  /* ---- the dashboard, derived from the same store ---- */
  http.get(`${base}/dashboard`, () => HttpResponse.json(dashboard())),
];
