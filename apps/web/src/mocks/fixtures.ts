import {
  SETTINGS_DEFAULTS,
  emptyCapabilityMap,
  type AccessKey,
  type Bucket,
  type Dashboard,
  type Job,
  type Me,
  type Notification,
  type SearchResult,
  type Server,
  type Settings,
} from '@storage-io/contracts';

/**
 * Fixtures for the dev mock API and the component tests.
 *
 * They mirror the concept's demo data (the same five servers, the same buckets and
 * numbers) so a screenshot of the real app can be compared with the concept page
 * side by side. They are NOT shipped: `src/mocks` is only loaded when
 * `VITE_MOCK_API=1`, or by a test that imports it.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.now();

function isoAgo(milliseconds: number): string {
  return new Date(NOW - milliseconds).toISOString();
}

function isoIn(milliseconds: number): string {
  return new Date(NOW + milliseconds).toISOString();
}

export const mockMe: Me = {
  username: 'admin',
  displayName: 'Administrator',
  email: 'admin@storage.local',
};

function server(
  overrides: Pick<Server, 'id' | 'name' | 'provider' | 'endpoint' | 'region' | 'status'> &
    Partial<Server>,
): Server {
  return {
    statusDetail: null,
    latencyMs: 12,
    lastCheckedAt: isoAgo(30_000),
    lastSeenAt: isoAgo(30_000),
    version: null,
    uptime24h: 1,
    capacity: { usedBytes: 0, totalBytes: null, budget: false },
    counts: { buckets: 0, users: null, objects: null },
    capabilities: emptyCapabilityMap(),
    options: {
      pathStyle: true,
      tlsVerify: true,
      caPem: null,
      adminEndpoint: null,
      iamEndpoint: null,
      healthIntervalSec: 30,
    },
    accessKeyId: 'sio-admin',
    secretMasked: '••••K7MD',
    maintenance: false,
    tls: true,
    createdAt: isoAgo(90 * DAY_MS),
    ...overrides,
  };
}

export const mockServers: readonly Server[] = [
  server({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'minio-prod-01',
    provider: 'minio',
    endpoint: 'https://s3.prod.acme.local:9000',
    region: 'us-east-1',
    status: 'healthy',
    latencyMs: 12,
    version: 'RELEASE.2026-08-14',
    capacity: { usedBytes: 8.6e12, totalBytes: 12e12, budget: false },
    counts: { buckets: 42, users: 21, objects: 18_400_000 },
  }),
  server({
    id: '22222222-2222-4222-8222-222222222222',
    name: 'seaweed-archive',
    provider: 'seaweedfs',
    endpoint: 'https://seaweed.dc2.acme.local:8333',
    region: 'dc-2',
    status: 'healthy',
    latencyMs: 8,
    capacity: { usedBytes: 6.1e12, totalBytes: 10e12, budget: false },
    counts: { buckets: 31, users: 9, objects: 12_100_000 },
  }),
  server({
    id: '33333333-3333-4333-8333-333333333333',
    name: 'aws-eu-backup',
    provider: 'aws',
    endpoint: 'https://s3.eu-central-1.amazonaws.com',
    region: 'eu-central-1',
    status: 'healthy',
    latencyMs: 38,
    capacity: { usedBytes: 2.9e12, totalBytes: 5e12, budget: true },
    counts: { buckets: 18, users: 4, objects: 380_000 },
  }),
  server({
    id: '44444444-4444-4444-8444-444444444444',
    name: 'ceph-lab',
    provider: 'ceph',
    endpoint: 'https://rgw.lab.acme.local',
    region: 'lab',
    status: 'degraded',
    statusDetail: 'Latency above 150 ms',
    latencyMs: 184,
    uptime24h: 0.94,
    capacity: { usedBytes: 0.7e12, totalBytes: 4e12, budget: false },
    counts: { buckets: 29, users: 4, objects: 2_300_000 },
  }),
  server({
    id: '55555555-5555-4555-8555-555555555555',
    name: 'garage-edge',
    provider: 'garage',
    endpoint: 'http://garage.edge-01.acme.local:3900',
    region: 'edge-01',
    status: 'offline',
    statusDetail: 'Connection refused on port 3900',
    latencyMs: null,
    lastSeenAt: isoAgo(14 * 60_000),
    uptime24h: 0.31,
    tls: false,
    capacity: { usedBytes: 0.1e12, totalBytes: 2e12, budget: false },
    counts: { buckets: 6, users: null, objects: null },
  }),
];

function bucket(
  overrides: Partial<Bucket> & Pick<Bucket, 'name' | 'serverId' | 'serverName' | 'provider'>,
): Bucket {
  return {
    region: 'us-east-1',
    createdAt: isoAgo(120 * DAY_MS),
    objects: 0,
    sizeBytes: 0,
    statsAt: isoAgo(HOUR_MS),
    versioning: 'enabled',
    objectLock: false,
    access: 'private',
    quota: null,
    unavailable: false,
    ...overrides,
  };
}

export const mockBuckets: readonly Bucket[] = [
  bucket({
    name: 'media-prod',
    serverId: mockServers[0]!.id,
    serverName: 'minio-prod-01',
    provider: 'minio',
    objects: 8_420_000,
    sizeBytes: 3.2e12,
    quota: { limitBytes: 4e12, mode: 'hard', threshold: 0.8, native: true },
  }),
  bucket({
    name: 'backups-daily',
    serverId: mockServers[1]!.id,
    serverName: 'seaweed-archive',
    provider: 'seaweedfs',
    region: 'dc-2',
    objects: 1_100_000,
    sizeBytes: 2.79e12,
    quota: { limitBytes: 3e12, mode: 'hard', threshold: 0.8, native: true },
  }),
  bucket({
    name: 'eu-db-snapshots',
    serverId: mockServers[2]!.id,
    serverName: 'aws-eu-backup',
    provider: 'aws',
    region: 'eu-central-1',
    objects: 38_200,
    sizeBytes: 1.9e12,
    objectLock: true,
  }),
  bucket({
    name: 'logs-2026',
    serverId: mockServers[0]!.id,
    serverName: 'minio-prod-01',
    provider: 'minio',
    objects: 21_700_000,
    sizeBytes: 0.92e12,
    versioning: 'suspended',
    quota: { limitBytes: 2e12, mode: 'alert', threshold: 0.8, native: false },
  }),
  bucket({
    name: 'ml-datasets',
    serverId: mockServers[3]!.id,
    serverName: 'ceph-lab',
    provider: 'ceph',
    region: 'lab',
    objects: 2_300_000,
    sizeBytes: 0.41e12,
    versioning: 'off',
  }),
];

const GROWTH_DAYS = 30;
const GROWTH_START_BYTES = 17.2e12;
const GROWTH_PER_DAY_BYTES = 4e10;

export const mockJobs: readonly Job[] = [
  {
    id: 'aaaa1111-1111-4111-8111-111111111111',
    name: 'Copy objects',
    type: 'copy',
    status: 'running',
    source: {
      serverId: mockServers[0]!.id,
      serverName: 'minio-prod-01',
      bucket: 'media-prod',
      filters: {
        prefix: 'raw/',
        modifiedAfter: null,
        modifiedBefore: null,
        minSize: null,
        maxSize: null,
        glob: null,
        tags: {},
      },
    },
    target: {
      serverId: mockServers[1]!.id,
      serverName: 'seaweed-archive',
      bucket: 'media-cold',
      prefix: '',
    },
    params: {},
    options: { conflict: 'skip', concurrency: 8, dryRun: false },
    schedule: { kind: 'now' },
    progress: {
      total: 645_000,
      processed: 412_900,
      failed: 0,
      skipped: 12,
      bytes: 1.8e12,
      objectsPerSec: 380,
      bytesPerSec: 1.6e9,
      etaSeconds: 1080,
    },
    parentId: null,
    createdAt: isoAgo(2 * HOUR_MS),
    startedAt: isoAgo(2 * HOUR_MS),
    finishedAt: null,
    waitingFor: null,
  },
];

export const mockDashboard: Dashboard = {
  totals: {
    usedBytes: 18.4e12,
    capacityBytes: 33e12,
    objects: 48_200_000,
    buckets: 126,
    usedDelta7dBytes: 1.2e12,
    objectsDeltaToday: 312_000,
    users: 38,
    accessKeys: 61,
    servers: { total: 5, healthy: 3, degraded: 1, offline: 1 },
    nearQuotaBuckets: 2,
  },
  growth: Array.from({ length: GROWTH_DAYS }, (_unused, index) => ({
    t: isoAgo((GROWTH_DAYS - index) * DAY_MS),
    usedBytes: GROWTH_START_BYTES + index * GROWTH_PER_DAY_BYTES,
  })),
  byServer: mockServers.map((entry) => ({
    serverId: entry.id,
    name: entry.name,
    provider: entry.provider,
    usedBytes: entry.capacity.usedBytes ?? 0,
    totalBytes: entry.capacity.totalBytes,
  })),
  jobs: [...mockJobs],
  activity: [],
  expiringKeys: [],
  largestBuckets: [...mockBuckets],
  incidents: [
    {
      serverId: mockServers[4]!.id,
      serverName: 'garage-edge',
      status: 'offline',
      detail: 'Connection refused on port 3900',
      since: isoAgo(14 * 60_000),
    },
  ],
};

export const mockAccessKeys: readonly AccessKey[] = [
  {
    serverId: mockServers[0]!.id,
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
];

export const mockNotifications: readonly Notification[] = [
  {
    id: 'n1',
    at: isoAgo(14 * 60_000),
    level: 'error',
    title: 'garage-edge is unreachable',
    detail: 'Connection refused on port 3900',
    href: '/servers',
    read: false,
  },
  {
    id: 'n2',
    at: isoAgo(HOUR_MS),
    level: 'warning',
    title: 'backups-daily reached 93% of its quota',
    detail: '2.79 TB of 3 TB',
    href: '/quotas',
    read: false,
  },
  {
    id: 'n3',
    at: isoAgo(6 * HOUR_MS),
    level: 'warning',
    title: 'Access key expires in 3 days',
    detail: 'backup-agent · AKIA…Q7F2',
    href: '/keys',
    read: true,
  },
];

export const mockSettings: Settings = SETTINGS_DEFAULTS;

export const mockSearchResults: readonly SearchResult[] = [
  ...mockServers.map((entry): SearchResult => ({
    type: 'server',
    id: entry.id,
    label: entry.name,
    sublabel: entry.endpoint,
    href: `/servers/${entry.name}`,
  })),
  ...mockBuckets.map((entry): SearchResult => ({
    type: 'bucket',
    id: `${entry.serverId}/${entry.name}`,
    label: entry.name,
    sublabel: entry.serverName,
    href: `/buckets/${entry.serverName}/${entry.name}`,
  })),
];
