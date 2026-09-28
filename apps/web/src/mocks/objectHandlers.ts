import {
  API_PREFIX,
  UPLOAD_HEADERS,
  type CopyObjectsRequest,
  type CopyObjectsResponse,
  type CreateFolderRequest,
  type DeleteObjectsRequest,
  type DeleteObjectsResponse,
  type ImportObjectFromUrlRequest,
  type ListObjectsResponse,
  type ObjectMeta,
  type ObjectMetadataBody,
  type ObjectRetentionBody,
  type ObjectTagsBody,
  type ObjectVersionList,
  type PresignRequest,
  type PresignResponse,
  type RenameObjectRequest,
  type RestoreVersionRequest,
  type SetObjectStorageClassRequest,
} from '@storage-io/contracts';
import { HttpResponse, http } from 'msw';
import { findBucket, makeObject, objectsFor, type ObjectRecord } from './bucketState';

/**
 * The object half of the dev mock API: listing with a real cursor, metadata,
 * versions, upload, download, copy/move, delete, rename, tags, retention, presign
 * and import-from-URL.
 *
 * The listing implements delimiter grouping the way S3 does — common prefixes are
 * collapsed into folders and only the objects directly under the prefix are
 * returned — because the browser's whole navigation model depends on that shape
 * being right.
 */

const base = API_PREFIX;
const NO_CONTENT = 204;
const CREATED = 201;
const CONFLICT = 409;
const DEFAULT_LIMIT = 200;
/** Above this many keys the API would hand the work to the job engine. */
const JOB_THRESHOLD = 1000;
const VERSIONS_PER_OBJECT = 3;
const DAY_MS = 86_400_000;

function problem(status: number, code: string, detail: string) {
  return HttpResponse.json(
    { type: 'about:blank', title: code, status, detail, code },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function metaOf(record: ObjectRecord): ObjectMeta {
  return {
    ...record.item,
    contentType: record.contentType,
    cacheControl: record.cacheControl,
    contentDisposition: record.contentDisposition,
    metadata: record.metadata,
    tags: record.tags,
    retention: record.retention,
    legalHold: record.legalHold,
    versionCount: VERSIONS_PER_OBJECT,
  };
}

/** S3's delimiter grouping: folders at this level, objects directly under it. */
function listLevel(
  records: readonly ObjectRecord[],
  prefix: string,
  delimiter: string,
  query: string,
): { readonly prefixes: readonly string[]; readonly objects: readonly ObjectRecord[] } {
  const prefixes = new Set<string>();
  const objects: ObjectRecord[] = [];

  for (const record of records) {
    const key = record.item.key;
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (rest === '') continue;

    if (delimiter !== '') {
      const slash = rest.indexOf(delimiter);
      if (slash !== -1) {
        prefixes.add(`${prefix}${rest.slice(0, slash + 1)}`);
        continue;
      }
    }
    if (query !== '' && !rest.toLowerCase().includes(query)) continue;
    objects.push(record);
  }

  const filteredPrefixes = [...prefixes].filter(
    (candidate) => query === '' || candidate.slice(prefix.length).toLowerCase().includes(query),
  );

  return { prefixes: filteredPrefixes.sort(), objects };
}

export const objectHandlers = [
  http.get(`${base}/servers/:sid/buckets/:bucket/objects`, ({ params, request }) => {
    const url = new URL(request.url);
    const prefix = url.searchParams.get('prefix') ?? '';
    const delimiter = url.searchParams.get('delimiter') ?? '/';
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const limit = Number.parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
    const cursor = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10);
    const showVersions = url.searchParams.get('showVersions') === 'true';

    const records = objectsFor(String(params.sid), String(params.bucket));
    const level = listLevel(records, prefix, showVersions ? '' : delimiter, query);

    // The cursor is an offset into the objects; folders all come with the first page.
    const start = Number.isFinite(cursor) ? cursor : 0;
    const slice = level.objects.slice(start, start + limit);
    const nextOffset = start + slice.length;
    const hasMore = nextOffset < level.objects.length;

    return HttpResponse.json({
      prefixes: start === 0 ? level.prefixes.map((value) => ({ prefix: value })) : [],
      objects: slice.map((record) => record.item),
      nextCursor: hasMore ? String(nextOffset) : null,
    } satisfies ListObjectsResponse);
  }),

  http.get(`${base}/servers/:sid/buckets/:bucket/objects/meta`, ({ params, request }) => {
    const key = new URL(request.url).searchParams.get('key') ?? '';
    const record = objectsFor(String(params.sid), String(params.bucket)).find(
      (entry) => entry.item.key === key,
    );
    if (record === undefined) return problem(404, 'NOT_FOUND', 'No such object.');
    return HttpResponse.json(metaOf(record));
  }),

  http.get(`${base}/servers/:sid/buckets/:bucket/objects/versions`, ({ params, request }) => {
    const key = new URL(request.url).searchParams.get('key') ?? '';
    const record = objectsFor(String(params.sid), String(params.bucket)).find(
      (entry) => entry.item.key === key,
    );
    if (record === undefined) return problem(404, 'NOT_FOUND', 'No such object.');

    const modified = Date.parse(record.item.lastModified);
    return HttpResponse.json({
      items: [
        {
          versionId: record.item.versionId ?? 'v1',
          lastModified: record.item.lastModified,
          size: record.item.size,
          isLatest: true,
          deleteMarker: false,
          etag: record.item.etag,
        },
        {
          versionId: `${record.item.versionId ?? 'v'}-prev`,
          lastModified: new Date(modified - 7 * DAY_MS).toISOString(),
          size: Math.round(record.item.size * 0.96),
          isLatest: false,
          deleteMarker: false,
          etag: record.item.etag,
        },
        {
          versionId: `${record.item.versionId ?? 'v'}-marker`,
          lastModified: new Date(modified - 9 * DAY_MS).toISOString(),
          size: 0,
          isLatest: false,
          deleteMarker: true,
          etag: null,
        },
      ],
    } satisfies ObjectVersionList);
  }),

  /** The bytes. Text objects answer with their text; anything else with zeros. */
  http.get(`${base}/servers/:sid/buckets/:bucket/objects/download`, ({ params, request }) => {
    const key = new URL(request.url).searchParams.get('key') ?? '';
    const record = objectsFor(String(params.sid), String(params.bucket)).find(
      (entry) => entry.item.key === key,
    );
    if (record === undefined) return problem(404, 'NOT_FOUND', 'No such object.');

    if (record.text !== null) {
      return new HttpResponse(record.text, {
        headers: {
          'content-type': record.contentType ?? 'text/plain',
          'content-length': String(new TextEncoder().encode(record.text).length),
        },
      });
    }
    // A small stand-in body: the mock is not here to serve 182 MB of video.
    const bytes = new Uint8Array(Math.min(record.item.size, 4096));
    return new HttpResponse(bytes, {
      headers: {
        'content-type': record.contentType ?? 'application/octet-stream',
        'content-length': String(bytes.length),
      },
    });
  }),

  http.post(`${base}/servers/:sid/buckets/:bucket/objects/download-zip`, () => {
    // Enough of a ZIP for the browser to save a file and for the flow to be real.
    const empty = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);
    return new HttpResponse(empty, { headers: { 'content-type': 'application/zip' } });
  }),

  http.put(`${base}/servers/:sid/buckets/:bucket/objects/upload`, async ({ params, request }) => {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') ?? '';
    const overwrite = url.searchParams.get('overwrite') !== 'false';
    const records = objectsFor(String(params.sid), String(params.bucket));
    const existing = records.findIndex((entry) => entry.item.key === key);

    if (existing !== -1 && !overwrite) {
      return problem(CONFLICT, 'CONFLICT', `${key} already exists.`);
    }

    const body = await request.arrayBuffer();
    const contentType = request.headers.get('content-type');
    const storageClass = request.headers.get(UPLOAD_HEADERS.storageClass);
    const tagsHeader = request.headers.get(UPLOAD_HEADERS.tags);

    const record = makeObject(key, body.byteLength, contentType);
    if (storageClass !== null) record.item = { ...record.item, storageClass };
    if (tagsHeader !== null) {
      const tags: Record<string, string> = {};
      for (const [name, value] of new URLSearchParams(tagsHeader)) tags[name] = value;
      record.tags = tags;
    }
    for (const [name, value] of request.headers) {
      if (!name.startsWith(UPLOAD_HEADERS.metaPrefix)) continue;
      record.metadata[name.slice(UPLOAD_HEADERS.metaPrefix.length)] = decodeURIComponent(value);
    }

    if (existing === -1) records.push(record);
    else records[existing] = record;

    return HttpResponse.json(record.item);
  }),

  http.put(`${base}/servers/:sid/buckets/:bucket/objects/content`, async ({ params, request }) => {
    const key = new URL(request.url).searchParams.get('key') ?? '';
    const text = await request.text();
    const records = objectsFor(String(params.sid), String(params.bucket));
    const index = records.findIndex((entry) => entry.item.key === key);
    if (index === -1) return problem(404, 'NOT_FOUND', 'No such object.');

    const previous = records[index]!;
    records[index] = {
      ...previous,
      text,
      item: {
        ...previous.item,
        size: new TextEncoder().encode(text).length,
        lastModified: new Date().toISOString(),
        versionId: `v-${Math.random().toString(36).slice(2, 10)}`,
      },
    };
    return HttpResponse.json(records[index].item);
  }),

  http.post(`${base}/servers/:sid/buckets/:bucket/objects/folder`, async ({ params, request }) => {
    const body = (await request.json()) as CreateFolderRequest;
    const records = objectsFor(String(params.sid), String(params.bucket));
    records.push(makeObject(body.prefix, 0, null));
    return new HttpResponse(null, { status: CREATED });
  }),

  http.post(`${base}/servers/:sid/buckets/:bucket/objects/delete`, async ({ params, request }) => {
    const body = (await request.json()) as DeleteObjectsRequest;
    const records = objectsFor(String(params.sid), String(params.bucket));

    const keys = new Set(body.objects.map((entry) => entry.key));
    let deleted = 0;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const key = records[index]!.item.key;
      const matchesPrefix = body.prefixes.some((prefix) => prefix !== '' && key.startsWith(prefix));
      if (!keys.has(key) && !matchesPrefix) continue;
      records.splice(index, 1);
      deleted += 1;
    }

    return HttpResponse.json({
      deleted,
      errors: [],
      job: null,
    } satisfies DeleteObjectsResponse);
  }),

  http.post(`${base}/servers/:sid/buckets/:bucket/objects/copy`, async ({ params, request }) => {
    const body = (await request.json()) as CopyObjectsRequest;
    const source = objectsFor(String(params.sid), String(params.bucket));
    const destination = objectsFor(body.destServerId, body.destBucket);

    const fromPrefixes = source.filter((entry) =>
      body.prefixes.some((prefix) => prefix !== '' && entry.item.key.startsWith(prefix)),
    );
    const fromKeys = source.filter((entry) => body.keys.includes(entry.item.key));
    const moving = [...new Set([...fromKeys, ...fromPrefixes])];

    if (moving.length > JOB_THRESHOLD) {
      return HttpResponse.json({ copied: 0, errors: [], job: null } satisfies CopyObjectsResponse);
    }

    let copied = 0;
    for (const entry of moving) {
      const name = entry.item.key.split('/').pop() ?? entry.item.key;
      const target = `${body.destPrefix}${name}`;
      const clash = destination.findIndex((candidate) => candidate.item.key === target);
      if (clash !== -1 && body.conflict === 'skip') continue;
      const copy = { ...entry, item: { ...entry.item, key: target } };
      if (clash !== -1 && body.conflict === 'overwrite') destination[clash] = copy;
      else destination.push(copy);
      copied += 1;
      if (!body.move) continue;
      const index = source.indexOf(entry);
      if (index !== -1) source.splice(index, 1);
    }

    return HttpResponse.json({ copied, errors: [], job: null } satisfies CopyObjectsResponse);
  }),

  http.post(`${base}/servers/:sid/buckets/:bucket/objects/rename`, async ({ params, request }) => {
    const body = (await request.json()) as RenameObjectRequest;
    const records = objectsFor(String(params.sid), String(params.bucket));
    const index = records.findIndex((entry) => entry.item.key === body.key);
    if (index === -1) return problem(404, 'NOT_FOUND', 'No such object.');
    if (records.some((entry) => entry.item.key === body.newKey)) {
      return problem(CONFLICT, 'CONFLICT', `${body.newKey} already exists.`);
    }
    const previous = records[index]!;
    records[index] = { ...previous, item: { ...previous.item, key: body.newKey } };
    return HttpResponse.json(records[index].item);
  }),

  http.post(
    `${base}/servers/:sid/buckets/:bucket/objects/restore-version`,
    async ({ params, request }) => {
      const body = (await request.json()) as RestoreVersionRequest;
      const records = objectsFor(String(params.sid), String(params.bucket));
      const index = records.findIndex((entry) => entry.item.key === body.key);
      if (index === -1) return problem(404, 'NOT_FOUND', 'No such object.');
      const previous = records[index]!;
      records[index] = {
        ...previous,
        item: {
          ...previous.item,
          lastModified: new Date().toISOString(),
          versionId: `v-${Math.random().toString(36).slice(2, 10)}`,
        },
      };
      return HttpResponse.json(records[index].item);
    },
  ),

  http.get(`${base}/servers/:sid/buckets/:bucket/objects/tags`, ({ params, request }) => {
    const key = new URL(request.url).searchParams.get('key') ?? '';
    const record = objectsFor(String(params.sid), String(params.bucket)).find(
      (entry) => entry.item.key === key,
    );
    if (record === undefined) return problem(404, 'NOT_FOUND', 'No such object.');
    return HttpResponse.json({ tags: record.tags } satisfies ObjectTagsBody);
  }),

  http.put(`${base}/servers/:sid/buckets/:bucket/objects/tags`, async ({ params, request }) => {
    const key = new URL(request.url).searchParams.get('key') ?? '';
    const body = (await request.json()) as ObjectTagsBody;
    const record = objectsFor(String(params.sid), String(params.bucket)).find(
      (entry) => entry.item.key === key,
    );
    if (record === undefined) return problem(404, 'NOT_FOUND', 'No such object.');
    record.tags = { ...body.tags };
    return HttpResponse.json({ tags: record.tags });
  }),

  http.put(`${base}/servers/:sid/buckets/:bucket/objects/metadata`, async ({ params, request }) => {
    const key = new URL(request.url).searchParams.get('key') ?? '';
    const body = (await request.json()) as ObjectMetadataBody;
    const record = objectsFor(String(params.sid), String(params.bucket)).find(
      (entry) => entry.item.key === key,
    );
    if (record === undefined) return problem(404, 'NOT_FOUND', 'No such object.');
    record.contentType = body.contentType;
    record.cacheControl = body.cacheControl;
    record.contentDisposition = body.contentDisposition;
    record.metadata = { ...body.metadata };
    return HttpResponse.json(metaOf(record));
  }),

  http.put(
    `${base}/servers/:sid/buckets/:bucket/objects/storage-class`,
    async ({ params, request }) => {
      const key = new URL(request.url).searchParams.get('key') ?? '';
      const body = (await request.json()) as SetObjectStorageClassRequest;
      const record = objectsFor(String(params.sid), String(params.bucket)).find(
        (entry) => entry.item.key === key,
      );
      if (record === undefined) return problem(404, 'NOT_FOUND', 'No such object.');
      record.item = { ...record.item, storageClass: body.storageClass };
      return HttpResponse.json(metaOf(record));
    },
  ),

  http.put(`${base}/servers/:sid/buckets/:bucket/objects/retention`, async ({ params, request }) => {
    const key = new URL(request.url).searchParams.get('key') ?? '';
    const body = (await request.json()) as ObjectRetentionBody;
    const record = objectsFor(String(params.sid), String(params.bucket)).find(
      (entry) => entry.item.key === key,
    );
    if (record === undefined) return problem(404, 'NOT_FOUND', 'No such object.');
    if ('legalHold' in body) record.legalHold = body.legalHold;
    else record.retention = { mode: body.mode, until: body.until };
    return HttpResponse.json(metaOf(record));
  }),

  http.post(`${base}/servers/:sid/buckets/:bucket/objects/presign`, async ({ params, request }) => {
    const body = (await request.json()) as PresignRequest;
    const bucket = findBucket(String(params.sid), String(params.bucket));
    const endpoint = bucket === undefined ? 'https://s3.local' : 'https://s3.prod.acme.local:9000';
    const url = new URL(`${endpoint}/${String(params.bucket)}/${body.key}`);
    url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
    url.searchParams.set('X-Amz-Expires', String(body.expiresInSeconds));
    if (body.download) url.searchParams.set('response-content-disposition', 'attachment');
    return HttpResponse.json({
      url: url.toString(),
      expiresAt: new Date(Date.now() + body.expiresInSeconds * 1000).toISOString(),
    } satisfies PresignResponse);
  }),

  http.post(
    `${base}/servers/:sid/buckets/:bucket/objects/import-url`,
    async ({ params, request }) => {
      const body = (await request.json()) as ImportObjectFromUrlRequest;
      const records = objectsFor(String(params.sid), String(params.bucket));
      if (records.some((entry) => entry.item.key === body.key) && !body.overwrite) {
        return problem(CONFLICT, 'CONFLICT', `${body.key} already exists.`);
      }
      const record = makeObject(body.key, 1_048_576, 'application/octet-stream');
      records.push(record);
      return HttpResponse.json(record.item);
    },
  ),

  http.delete(`${base}/servers/:sid/buckets/:bucket/objects`, () =>
    new HttpResponse(null, { status: NO_CONTENT }),
  ),
];
