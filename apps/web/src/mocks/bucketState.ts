import {
  QUOTA_THRESHOLD_DEFAULT,
  type Bucket,
  type BucketCorsBody,
  type BucketDetail,
  type BucketLifecycleBody,
  type BucketNotificationsBody,
  type BucketObjectLockResponse,
  type BucketPolicyBody,
  type BucketReplicationResponse,
  type BucketVersioningBody,
  type LifecycleRule,
  type NotificationTargetStatusList,
  type ObjectItem,
  type Quota,
} from '@storage-io/contracts';
import { mockBuckets, mockServers } from './fixtures';

/**
 * In-memory bucket and object state for the dev mock API.
 *
 * It is mutable on purpose: the point of `pnpm dev:mock` is to exercise the real
 * flows, and a create that does not appear in the list, or a lifecycle rule that
 * does not survive a save, exercises nothing. The data starts from the concept's
 * demo inventory so a screenshot lines up with `design/concept/`.
 *
 * Not shipped: `src/mocks` only loads when `VITE_MOCK_API=1`.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function isoAgo(milliseconds: number): string {
  return new Date(Date.now() - milliseconds).toISOString();
}

export interface BucketRecord {
  bucket: Bucket;
  detail: Pick<BucketDetail, 'owner' | 'tags' | 'defaultStorageClass' | 'noncurrentVersions'>;
  policy: Record<string, unknown> | null;
  lifecycle: LifecycleRule[];
  cors: BucketCorsBody['rules'];
  replication: BucketReplicationResponse;
  notifications: BucketNotificationsBody['targets'];
  objectLock: BucketObjectLockResponse;
}

/** The demo inventory, extended to the 10 buckets the concept's table draws. */
const EXTRA_BUCKETS: readonly Bucket[] = [
  {
    serverId: mockServers[1]!.id,
    serverName: 'seaweed-archive',
    provider: 'seaweedfs',
    name: 'analytics-parquet',
    region: 'dc-2',
    createdAt: isoAgo(600 * DAY_MS),
    objects: 412_000,
    sizeBytes: 1.2e12,
    statsAt: isoAgo(HOUR_MS),
    versioning: 'off',
    objectLock: false,
    access: 'custom',
    quota: { limitBytes: 2e12, mode: 'hard', threshold: 0.8, native: true },
    unavailable: false,
  },
  {
    serverId: mockServers[2]!.id,
    serverName: 'aws-eu-backup',
    provider: 'aws',
    name: 'mail-archive',
    region: 'eu-central-1',
    createdAt: isoAgo(1200 * DAY_MS),
    objects: 2_600_000,
    sizeBytes: 0.64e12,
    statsAt: isoAgo(HOUR_MS),
    versioning: 'enabled',
    objectLock: false,
    access: 'private',
    quota: null,
    unavailable: false,
  },
  {
    serverId: mockServers[0]!.id,
    serverName: 'minio-prod-01',
    provider: 'minio',
    name: 'ci-artifacts',
    region: 'us-east-1',
    createdAt: isoAgo(400 * DAY_MS),
    objects: 96_400,
    sizeBytes: 0.31e12,
    statsAt: isoAgo(HOUR_MS),
    versioning: 'off',
    objectLock: false,
    access: 'private',
    quota: { limitBytes: 0.5e12, mode: 'hard', threshold: 0.8, native: true },
    unavailable: false,
  },
  {
    serverId: mockServers[4]!.id,
    serverName: 'garage-edge',
    provider: 'garage',
    name: 'edge-cache',
    region: 'edge-01',
    createdAt: isoAgo(200 * DAY_MS),
    objects: 184_000,
    sizeBytes: 96e9,
    statsAt: isoAgo(6 * HOUR_MS),
    versioning: 'off',
    objectLock: false,
    access: 'private',
    quota: null,
    unavailable: true,
  },
  {
    serverId: mockServers[0]!.id,
    serverName: 'minio-prod-01',
    provider: 'minio',
    name: 'public-assets',
    region: 'us-east-1',
    createdAt: isoAgo(1000 * DAY_MS),
    objects: 38_112,
    sizeBytes: 84e9,
    statsAt: isoAgo(HOUR_MS),
    versioning: 'off',
    objectLock: false,
    access: 'public-read',
    quota: null,
    unavailable: false,
  },
];

const SAMPLE_POLICY: Record<string, unknown> = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AllowThumbnailService',
      Effect: 'Allow',
      Principal: { AWS: ['arn:aws:iam:::user/svc-thumbnails'] },
      Action: ['s3:GetObject', 's3:PutObject'],
      Resource: ['arn:aws:s3:::media-prod/*'],
    },
  ],
};

function record(bucket: Bucket): BucketRecord {
  const isMedia = bucket.name === 'media-prod';
  return {
    bucket: { ...bucket },
    detail: {
      owner: 'sio-admin',
      tags: isMedia ? { env: 'prod', team: 'media', 'cost-center': 'mkt-204' } : {},
      defaultStorageClass: 'STANDARD',
      noncurrentVersions: bucket.versioning === 'enabled' ? 412 : 0,
    },
    policy: bucket.access === 'custom' || isMedia ? SAMPLE_POLICY : null,
    lifecycle: isMedia
      ? [
          {
            id: 'expire-raw-30d',
            enabled: true,
            prefix: 'raw/',
            tags: {},
            expireDays: 30,
            noncurrentExpireDays: null,
            abortMultipartDays: null,
            transition: null,
            expiredDeleteMarkers: false,
          },
          {
            id: 'clean-noncurrent',
            enabled: true,
            prefix: '',
            tags: {},
            expireDays: null,
            noncurrentExpireDays: 14,
            abortMultipartDays: null,
            transition: null,
            expiredDeleteMarkers: false,
          },
          {
            id: 'abort-stale-uploads',
            enabled: false,
            prefix: 'uploads/',
            tags: {},
            expireDays: null,
            noncurrentExpireDays: null,
            abortMultipartDays: 7,
            transition: null,
            expiredDeleteMarkers: false,
          },
        ]
      : [],
    cors: isMedia
      ? [
          {
            allowedOrigins: ['https://acme.com', 'https://cdn.acme.com'],
            allowedMethods: ['GET', 'HEAD'],
            allowedHeaders: ['*'],
            exposeHeaders: ['ETag', 'x-amz-request-id'],
            maxAgeSeconds: 3600,
          },
        ]
      : [],
    replication: isMedia
      ? {
          rules: [
            {
              id: 'to-seaweed-archive',
              enabled: true,
              prefix: 'raw/',
              destination: { bucketArn: 'arn:aws:s3:::media-replica', storageClass: null },
              deleteMarkers: false,
              priority: 1,
            },
          ],
          status: 'Active · 1840 pending',
        }
      : { rules: [], status: null },
    notifications: isMedia
      ? [
          {
            id: 'arn:minio:sqs::webhook:webhook',
            arn: 'https://hooks.acme.local/s3-events',
            kind: 'queue',
            events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:Delete'],
            prefix: 'raw/',
            suffix: '',
          },
          {
            id: 'arn:minio:sqs::indexer:webhook',
            arn: 'https://media-indexer.acme.local/hook',
            kind: 'queue',
            events: ['s3:ObjectCreated:Put'],
            prefix: '',
            suffix: '.jpg',
          },
        ]
      : [],
    objectLock: {
      enabled: bucket.objectLock,
      mode: bucket.objectLock ? 'GOVERNANCE' : null,
      days: bucket.objectLock ? 30 : null,
      years: null,
    },
  };
}

function keyOf(serverId: string, bucket: string): string {
  return `${serverId}/${bucket}`;
}

export const bucketStore = new Map<string, BucketRecord>();

for (const bucket of [...mockBuckets, ...EXTRA_BUCKETS]) {
  bucketStore.set(keyOf(bucket.serverId, bucket.name), record(bucket));
}
// The concept's media-prod has object lock on; the fixture does not say so.
const media = bucketStore.get(keyOf(mockServers[0]!.id, 'media-prod'));
if (media !== undefined) {
  media.bucket = { ...media.bucket, objectLock: true };
  media.objectLock = { enabled: true, mode: 'GOVERNANCE', days: 30, years: null };
}

/** `:sid` accepts an id or a name, so the mock resolves both like the API does. */
export function resolveServerId(candidate: string): string {
  const byName = mockServers.find((server) => server.name === candidate);
  return byName?.id ?? candidate;
}

export function findBucket(serverParam: string, bucket: string): BucketRecord | undefined {
  return bucketStore.get(keyOf(resolveServerId(serverParam), bucket));
}

export function allBuckets(): readonly BucketRecord[] {
  return [...bucketStore.values()];
}

export function deleteBucket(serverParam: string, bucket: string): void {
  bucketStore.delete(keyOf(resolveServerId(serverParam), bucket));
}

export function addBucket(entry: BucketRecord): void {
  bucketStore.set(keyOf(entry.bucket.serverId, entry.bucket.name), entry);
}

export function quotaFor(limitBytes: number | null, mode: Quota['mode'], threshold: number): Quota | null {
  if (limitBytes === null) return null;
  return { limitBytes, mode, threshold, native: mode === 'hard' };
}

export const DEFAULT_THRESHOLD = QUOTA_THRESHOLD_DEFAULT;

export function versioningOf(record_: BucketRecord): BucketVersioningBody {
  return { status: record_.bucket.versioning === 'suspended' ? 'suspended' : 'enabled' };
}

export function policyOf(record_: BucketRecord): BucketPolicyBody {
  return { policy: record_.policy };
}

export function lifecycleOf(record_: BucketRecord): BucketLifecycleBody {
  return { rules: record_.lifecycle };
}

export function notificationStatusOf(record_: BucketRecord): NotificationTargetStatusList {
  return {
    items: record_.notifications.map((target, index) => ({
      targetId: target.id,
      arn: target.arn,
      state: index === 0 ? 'online' : 'offline',
      detail: index === 0 ? '12 400 events today' : '504 Gateway Timeout · 318 queued',
    })),
  };
}

/* ------------------------------ objects ---------------------------------- */

export interface ObjectRecord {
  item: ObjectItem;
  contentType: string | null;
  cacheControl: string | null;
  contentDisposition: string | null;
  metadata: Record<string, string>;
  tags: Record<string, string>;
  retention: { mode: 'GOVERNANCE' | 'COMPLIANCE'; until: string } | null;
  legalHold: boolean;
  /** Only kept for the text objects the editor opens. */
  text: string | null;
}

const DEMO_PREFIX = '2026/09/campaign-autumn/';

function object(
  key: string,
  size: number,
  contentType: string | null,
  modifiedDaysAgo: number,
  text: string | null = null,
): ObjectRecord {
  return {
    item: {
      key,
      size,
      lastModified: isoAgo(modifiedDaysAgo * DAY_MS),
      etag: `"${key.length.toString(16)}b2cf535f27731c974343645a398${(size % 1000).toString().padStart(3, '0')}"`,
      storageClass: 'STANDARD',
      versionId: `v-${key.replace(/[^a-z0-9]/gi, '').slice(-8)}`,
      isLatest: true,
      deleteMarker: false,
    },
    contentType,
    cacheControl: contentType?.startsWith('image/') === true ? 'max-age=31536000' : null,
    contentDisposition: null,
    metadata: contentType?.startsWith('image/') === true ? { author: 'design-team' } : {},
    tags: { campaign: 'autumn-2026', owner: 'design' },
    retention: null,
    legalHold: false,
    text,
  };
}

const COPY_DECK = `# Autumn campaign — copy deck

## Hero
**Headline:** Fall into something new
**Sub:** Limited colours, until Nov 30.

## CTA
- Shop the collection
- See the lookbook

## Legal
Prices valid in participating stores only.
`;

const PALETTE = `{
  "primary": "#4c2bd9",
  "accent": "#00b6a4",
  "neutral": ["#0f0f11", "#4b4b52", "#f4f4f6"]
}
`;

/** Keyed by `serverId/bucket`, so each bucket has its own object list. */
export const objectStore = new Map<string, ObjectRecord[]>();

function seedObjects(): void {
  const mediaKey = keyOf(mockServers[0]!.id, 'media-prod');
  objectStore.set(mediaKey, [
    object(`${DEMO_PREFIX}raw/raw-shot-0141.cr3`, 49.1e6, 'image/x-canon-cr3', 3),
    object(`${DEMO_PREFIX}raw/raw-shot-0142.cr3`, 48.2e6, 'image/x-canon-cr3', 3),
    object(`${DEMO_PREFIX}exports/hero-2400.jpg`, 3.1e6, 'image/jpeg', 2),
    object(`${DEMO_PREFIX}hero-banner@2x.jpg`, 4.8e6, 'image/jpeg', 1),
    object(`${DEMO_PREFIX}product-teaser.mp4`, 182.4e6, 'video/mp4', 2),
    object(`${DEMO_PREFIX}brand-guidelines.pdf`, 12.1e6, 'application/pdf', 4),
    object(`${DEMO_PREFIX}copy-deck.md`, COPY_DECK.length, 'text/markdown', 1, COPY_DECK),
    object(`${DEMO_PREFIX}palette.json`, PALETTE.length, 'application/json', 6, PALETTE),
    object(`${DEMO_PREFIX}assets-bundle.zip`, 1.2e9, 'application/zip', 3),
    object(`${DEMO_PREFIX}storyboard.png`, 6.7e6, 'image/png', 5),
    object(`${DEMO_PREFIX}thumbnail-03.webp`, 312e3, 'image/webp', 7),
    object(`${DEMO_PREFIX}README.txt`, 1.1e3, 'text/plain', 8, 'Autumn campaign assets.\n'),
    object('2026/08/campaign-summer/hero.jpg', 4.2e6, 'image/jpeg', 40),
    object('logs/2026-09-27.log', 8.4e6, 'text/plain', 1, 'INFO started\n'),
  ]);
}

seedObjects();

export function objectsFor(serverParam: string, bucket: string): ObjectRecord[] {
  const key = keyOf(resolveServerId(serverParam), bucket);
  const existing = objectStore.get(key);
  if (existing !== undefined) return existing;
  const created: ObjectRecord[] = [];
  objectStore.set(key, created);
  return created;
}

export function makeObject(
  key: string,
  size: number,
  contentType: string | null,
  text: string | null = null,
): ObjectRecord {
  return {
    item: {
      key,
      size,
      lastModified: new Date().toISOString(),
      etag: `"${Math.random().toString(16).slice(2, 18)}"`,
      storageClass: 'STANDARD',
      versionId: `v-${Math.random().toString(36).slice(2, 10)}`,
      isLatest: true,
      deleteMarker: false,
    },
    contentType,
    cacheControl: null,
    contentDisposition: null,
    metadata: {},
    tags: {},
    retention: null,
    legalHold: false,
    text,
  };
}
