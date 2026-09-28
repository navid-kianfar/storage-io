import {
  API_PREFIX,
  PAGE_SIZE_DEFAULT,
  type Bucket,
  type BucketAccessBody,
  type BucketAccessResponse,
  type BucketBulkRequest,
  type BucketBulkResponse,
  type BucketCorsBody,
  type BucketDetail,
  type BucketLifecycleBody,
  type BucketList,
  type BucketNotificationsBody,
  type BucketObjectLockBody,
  type BucketPolicyBody,
  type BucketQuotaBody,
  type BucketQuotaResponse,
  type BucketReplicationBody,
  type BucketTagsBody,
  type BucketVersioningBody,
  type CreateBucketRequest,
  type EmptyBucketRequest,
  type Job,
} from '@storage-io/contracts';
import { HttpResponse, http } from 'msw';
import {
  addBucket,
  allBuckets,
  deleteBucket,
  findBucket,
  lifecycleOf,
  notificationStatusOf,
  objectsFor,
  policyOf,
  quotaFor,
  resolveServerId,
  versioningOf,
  type BucketRecord,
} from './bucketState';
import { mockServers } from './fixtures';

/**
 * The bucket half of the dev mock API: the aggregated list with its summary and
 * filters, one bucket's detail, every sub-resource's GET/PUT pair, the bulk
 * endpoint and the empty-bucket job.
 *
 * It is stateful (see `bucketState.ts`) because the flows being exercised are
 * write flows: a lifecycle rule that vanishes on save proves nothing.
 */

const base = API_PREFIX;
const NO_CONTENT = 204;
const CREATED = 201;
const ACCEPTED = 202;
const CONFLICT = 409;
const NEAR_QUOTA_RATIO = 0.8;

function problem(status: number, code: string, detail: string) {
  return HttpResponse.json(
    { type: 'about:blank', title: code, status, detail, code },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function notFound(detail = 'That bucket is not on this server.') {
  return problem(404, 'NOT_FOUND', detail);
}

/** Resolves `:sid/:bucket` once, so every handler below is two lines shorter. */
function withBucket(
  serverParam: string,
  bucketParam: string,
  handler: (entry: BucketRecord) => Response,
): Response {
  const entry = findBucket(serverParam, bucketParam);
  if (entry === undefined) return notFound();
  return handler(entry);
}

function detailOf(entry: BucketRecord): BucketDetail {
  return { ...entry.bucket, ...entry.detail };
}

function quotaResponse(entry: BucketRecord): BucketQuotaResponse {
  return {
    quota: entry.bucket.quota,
    usage: {
      sizeBytes: entry.bucket.sizeBytes ?? 0,
      objects: entry.bucket.objects ?? 0,
    },
  };
}

function emptyJob(entry: BucketRecord, includeVersions: boolean): Job {
  const now = new Date().toISOString();
  return {
    id: `job-${Math.random().toString(36).slice(2, 10)}`,
    name: `Empty ${entry.bucket.name}`,
    type: 'empty-bucket',
    status: 'running',
    source: {
      serverId: entry.bucket.serverId,
      serverName: entry.bucket.serverName,
      bucket: entry.bucket.name,
      filters: {
        prefix: '',
        modifiedAfter: null,
        modifiedBefore: null,
        minSize: null,
        maxSize: null,
        glob: null,
        tags: {},
      },
      keyCount: null,
    },
    target: null,
    params: { includeVersions },
    options: { conflict: 'overwrite', concurrency: 8, dryRun: false },
    schedule: { kind: 'now' },
    progress: {
      total: entry.bucket.objects,
      processed: 0,
      failed: 0,
      skipped: 0,
      bytes: 0,
      objectsPerSec: 0,
      bytesPerSec: 0,
      etaSeconds: null,
    },
    parentId: null,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    waitingFor: null,
  };
}

function sortBuckets(items: readonly Bucket[], sort: string): readonly Bucket[] {
  const copy = [...items];
  if (sort === 'name') return copy.sort((left, right) => left.name.localeCompare(right.name));
  if (sort === 'quota') {
    const ratio = (bucket: Bucket) =>
      bucket.quota === null || bucket.sizeBytes === null
        ? -1
        : bucket.sizeBytes / bucket.quota.limitBytes;
    return copy.sort((left, right) => ratio(right) - ratio(left));
  }
  if (sort === 'written') {
    return copy.sort((left, right) => (right.statsAt ?? '').localeCompare(left.statsAt ?? ''));
  }
  return copy.sort((left, right) => (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0));
}

export const bucketHandlers = [
  http.get(`${base}/buckets`, ({ request }) => {
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const serverId = url.searchParams.get('serverId');
    const access = url.searchParams.get('access');
    const sort = url.searchParams.get('sort') ?? 'size';
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const pageSize = Number.parseInt(
      url.searchParams.get('pageSize') ?? String(PAGE_SIZE_DEFAULT),
      10,
    );

    const all = allBuckets().map((entry) => entry.bucket);
    const filtered = all.filter((bucket) => {
      if (query !== '' && !bucket.name.toLowerCase().includes(query)) return false;
      if (serverId !== null && serverId !== '' && bucket.serverId !== resolveServerId(serverId)) {
        return false;
      }
      if (access !== null && access !== '' && bucket.access !== access) return false;
      return true;
    });

    const sorted = sortBuckets(filtered, sort);
    const start = (Math.max(1, page) - 1) * pageSize;
    const items = sorted.slice(start, start + pageSize);

    const summary = {
      buckets: filtered.length,
      sizeBytes: filtered.reduce((sum, bucket) => sum + (bucket.sizeBytes ?? 0), 0),
      objects: filtered.reduce((sum, bucket) => sum + (bucket.objects ?? 0), 0),
      withQuota: filtered.filter((bucket) => bucket.quota !== null).length,
      nearQuota: filtered.filter(
        (bucket) =>
          bucket.quota !== null &&
          bucket.sizeBytes !== null &&
          bucket.sizeBytes / bucket.quota.limitBytes >= NEAR_QUOTA_RATIO,
      ).length,
      public: filtered.filter((bucket) => bucket.access === 'public-read').length,
    };

    return HttpResponse.json({ items, total: filtered.length, summary } satisfies BucketList);
  }),

  http.post(`${base}/servers/:sid/buckets`, async ({ params, request }) => {
    const body = (await request.json()) as CreateBucketRequest;
    const serverId = resolveServerId(String(params.sid));
    const server = mockServers.find((entry) => entry.id === serverId);
    if (server === undefined) return notFound('No such server.');
    if (findBucket(serverId, body.name) !== undefined) {
      return problem(CONFLICT, 'CONFLICT', `${body.name} already exists on ${server.name}.`);
    }

    const bucket: Bucket = {
      serverId,
      serverName: server.name,
      provider: server.provider,
      name: body.name,
      region: body.region ?? server.region,
      createdAt: new Date().toISOString(),
      objects: 0,
      sizeBytes: 0,
      statsAt: new Date().toISOString(),
      versioning: body.versioning ? 'enabled' : 'off',
      objectLock: body.objectLock,
      access: body.access,
      quota: quotaFor(body.quota?.limitBytes ?? null, body.quota?.mode ?? 'hard', 0.8),
      unavailable: false,
    };

    addBucket({
      bucket,
      detail: {
        owner: 'sio-admin',
        tags: {},
        defaultStorageClass: 'STANDARD',
        noncurrentVersions: 0,
      },
      policy: null,
      lifecycle: [],
      cors: [],
      replication: { rules: [], status: null },
      notifications: [],
      objectLock: {
        enabled: body.objectLock,
        mode: body.objectLock ? 'GOVERNANCE' : null,
        days: body.objectLock ? 30 : null,
        years: null,
      },
    });

    return HttpResponse.json(bucket, { status: CREATED });
  }),

  http.get(`${base}/servers/:sid/buckets/:bucket`, ({ params }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) =>
      HttpResponse.json(detailOf(entry)),
    ),
  ),

  http.delete(`${base}/servers/:sid/buckets/:bucket`, ({ params, request }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) => {
      const force = new URL(request.url).searchParams.get('force') === 'true';
      const objects = objectsFor(String(params.sid), String(params.bucket));
      if (!force && objects.length > 0) {
        return problem(
          CONFLICT,
          'BUCKET_NOT_EMPTY',
          `${entry.bucket.name} still contains ${String(objects.length)} objects.`,
        );
      }
      deleteBucket(String(params.sid), String(params.bucket));
      objects.length = 0;
      return new HttpResponse(null, { status: NO_CONTENT });
    }),
  ),

  http.post(`${base}/servers/:sid/buckets/:bucket/empty`, async ({ params, request }) => {
    const body = (await request.json()) as EmptyBucketRequest;
    return withBucket(String(params.sid), String(params.bucket), (entry) => {
      objectsFor(String(params.sid), String(params.bucket)).length = 0;
      entry.bucket = { ...entry.bucket, objects: 0, sizeBytes: 0 };
      return HttpResponse.json(emptyJob(entry, body.includeVersions), { status: ACCEPTED });
    });
  }),

  /* ------------------------------ sub-resources ------------------------- */

  http.get(`${base}/servers/:sid/buckets/:bucket/access`, ({ params }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) =>
      HttpResponse.json({
        access: entry.bucket.access,
        policy: entry.policy,
      } satisfies BucketAccessResponse),
    ),
  ),

  http.put(`${base}/servers/:sid/buckets/:bucket/access`, async ({ params, request }) => {
    const body = (await request.json()) as BucketAccessBody;
    return withBucket(String(params.sid), String(params.bucket), (entry) => {
      entry.bucket = { ...entry.bucket, access: body.access };
      entry.policy = body.access === 'public-read' ? { Version: '2012-10-17', Statement: [] } : null;
      return HttpResponse.json({
        access: entry.bucket.access,
        policy: entry.policy,
      } satisfies BucketAccessResponse);
    });
  }),

  http.get(`${base}/servers/:sid/buckets/:bucket/policy`, ({ params }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) =>
      HttpResponse.json(policyOf(entry)),
    ),
  ),

  http.put(`${base}/servers/:sid/buckets/:bucket/policy`, async ({ params, request }) => {
    const body = (await request.json()) as BucketPolicyBody;
    return withBucket(String(params.sid), String(params.bucket), (entry) => {
      entry.policy = body.policy;
      entry.bucket = { ...entry.bucket, access: body.policy === null ? 'private' : 'custom' };
      return HttpResponse.json({ policy: entry.policy } satisfies BucketPolicyBody);
    });
  }),

  http.get(`${base}/servers/:sid/buckets/:bucket/versioning`, ({ params }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) =>
      HttpResponse.json(versioningOf(entry)),
    ),
  ),

  http.put(`${base}/servers/:sid/buckets/:bucket/versioning`, async ({ params, request }) => {
    const body = (await request.json()) as BucketVersioningBody;
    return withBucket(String(params.sid), String(params.bucket), (entry) => {
      entry.bucket = { ...entry.bucket, versioning: body.status };
      return HttpResponse.json(body);
    });
  }),

  http.get(`${base}/servers/:sid/buckets/:bucket/object-lock`, ({ params }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) =>
      HttpResponse.json(entry.objectLock),
    ),
  ),

  http.put(`${base}/servers/:sid/buckets/:bucket/object-lock`, async ({ params, request }) => {
    const body = (await request.json()) as BucketObjectLockBody;
    return withBucket(String(params.sid), String(params.bucket), (entry) => {
      if (!entry.objectLock.enabled) {
        return problem(CONFLICT, 'CONFLICT', 'Object lock can only be enabled at creation.');
      }
      entry.objectLock = { ...body, enabled: true };
      return HttpResponse.json(entry.objectLock);
    });
  }),

  http.get(`${base}/servers/:sid/buckets/:bucket/lifecycle`, ({ params }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) =>
      HttpResponse.json(lifecycleOf(entry)),
    ),
  ),

  http.put(`${base}/servers/:sid/buckets/:bucket/lifecycle`, async ({ params, request }) => {
    const body = (await request.json()) as BucketLifecycleBody;
    return withBucket(String(params.sid), String(params.bucket), (entry) => {
      entry.lifecycle = [...body.rules];
      return HttpResponse.json({ rules: entry.lifecycle });
    });
  }),

  http.get(`${base}/servers/:sid/buckets/:bucket/cors`, ({ params }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) =>
      HttpResponse.json({ rules: entry.cors } satisfies BucketCorsBody),
    ),
  ),

  http.put(`${base}/servers/:sid/buckets/:bucket/cors`, async ({ params, request }) => {
    const body = (await request.json()) as BucketCorsBody;
    return withBucket(String(params.sid), String(params.bucket), (entry) => {
      entry.cors = [...body.rules];
      return HttpResponse.json({ rules: entry.cors });
    });
  }),

  http.get(`${base}/servers/:sid/buckets/:bucket/tags`, ({ params }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) =>
      HttpResponse.json({ tags: entry.detail.tags } satisfies BucketTagsBody),
    ),
  ),

  http.put(`${base}/servers/:sid/buckets/:bucket/tags`, async ({ params, request }) => {
    const body = (await request.json()) as BucketTagsBody;
    return withBucket(String(params.sid), String(params.bucket), (entry) => {
      entry.detail = { ...entry.detail, tags: { ...body.tags } };
      return HttpResponse.json({ tags: entry.detail.tags });
    });
  }),

  http.get(`${base}/servers/:sid/buckets/:bucket/replication`, ({ params }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) =>
      HttpResponse.json(entry.replication),
    ),
  ),

  http.put(`${base}/servers/:sid/buckets/:bucket/replication`, async ({ params, request }) => {
    const body = (await request.json()) as BucketReplicationBody;
    return withBucket(String(params.sid), String(params.bucket), (entry) => {
      entry.replication = { rules: [...body.rules], status: entry.replication.status };
      return HttpResponse.json(entry.replication);
    });
  }),

  // `/notifications/status` is registered first: MSW matches in order, and the
  // plain `/notifications` pattern would otherwise swallow it.
  http.get(`${base}/servers/:sid/buckets/:bucket/notifications/status`, ({ params }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) =>
      HttpResponse.json(notificationStatusOf(entry)),
    ),
  ),

  http.get(`${base}/servers/:sid/buckets/:bucket/notifications`, ({ params }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) =>
      HttpResponse.json({ targets: entry.notifications } satisfies BucketNotificationsBody),
    ),
  ),

  http.put(`${base}/servers/:sid/buckets/:bucket/notifications`, async ({ params, request }) => {
    const body = (await request.json()) as BucketNotificationsBody;
    return withBucket(String(params.sid), String(params.bucket), (entry) => {
      entry.notifications = [...body.targets];
      return HttpResponse.json({ targets: entry.notifications });
    });
  }),

  http.get(`${base}/servers/:sid/buckets/:bucket/quota`, ({ params }) =>
    withBucket(String(params.sid), String(params.bucket), (entry) =>
      HttpResponse.json(quotaResponse(entry)),
    ),
  ),

  http.put(`${base}/servers/:sid/buckets/:bucket/quota`, async ({ params, request }) => {
    const body = (await request.json()) as BucketQuotaBody;
    return withBucket(String(params.sid), String(params.bucket), (entry) => {
      entry.bucket = {
        ...entry.bucket,
        quota: quotaFor(body.limitBytes, body.mode, body.threshold),
      };
      return HttpResponse.json(quotaResponse(entry));
    });
  }),

  /* --------------------------------- bulk -------------------------------- */

  http.post(`${base}/buckets/bulk`, async ({ request }) => {
    const body = (await request.json()) as BucketBulkRequest;

    const results = body.buckets.map((ref) => {
      const entry = findBucket(ref.serverId, ref.bucket);
      if (entry === undefined) {
        return { ...ref, ok: false, message: 'No such bucket.' };
      }

      switch (body.action) {
        case 'quota':
          entry.bucket = {
            ...entry.bucket,
            quota: quotaFor(body.payload.limitBytes, body.payload.mode, body.payload.threshold),
          };
          return { ...ref, ok: true, message: null };
        case 'tags':
          entry.detail = { ...entry.detail, tags: { ...body.payload.tags } };
          return { ...ref, ok: true, message: null };
        case 'access':
          entry.bucket = { ...entry.bucket, access: body.payload.access };
          return { ...ref, ok: true, message: null };
        case 'lifecycle-rule': {
          const rules = entry.lifecycle.filter((rule) => rule.id !== body.payload.id);
          entry.lifecycle = [...rules, body.payload];
          return { ...ref, ok: true, message: null };
        }
        case 'delete': {
          const objects = objectsFor(ref.serverId, ref.bucket);
          if (objects.length > 0 && !body.payload.force) {
            return {
              ...ref,
              ok: false,
              message: `BUCKET_NOT_EMPTY: ${String(objects.length)} objects`,
            };
          }
          objects.length = 0;
          deleteBucket(ref.serverId, ref.bucket);
          return { ...ref, ok: true, message: null };
        }
      }
    });

    return HttpResponse.json({ results } satisfies BucketBulkResponse);
  }),
];
