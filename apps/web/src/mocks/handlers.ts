import { API_PREFIX, type SearchResponse } from '@storage-io/contracts';
import { HttpResponse, http } from 'msw';
import {
  mockAccessKeys,
  mockBuckets,
  mockDashboard,
  mockJobs,
  mockMe,
  mockNotifications,
  mockSearchResults,
  mockServers,
  mockSettings,
} from './fixtures';
import { bucketHandlers } from './bucketHandlers';
import { iamHandlers } from './iamHandlers';
import { jobHandlers } from './jobHandlers';
import { objectHandlers } from './objectHandlers';
import { pageHandlers } from './pageHandlers';
import { settingsHandlers } from './settingsHandlers';

/**
 * Dev-only mock API, so the shell and every page render before apps/api exists.
 *
 * Start it with `VITE_MOCK_API=1 pnpm --filter @storage-io/web dev`. It is not in
 * the production bundle: main.tsx imports it behind that flag.
 *
 * It is deliberately thin — enough for the UI to render truthfully, not a second
 * implementation of the API. When the real API is up, turn the flag off.
 */

const base = API_PREFIX;

const HTTP_UNAUTHORIZED = 401;
const HTTP_NO_CONTENT = 204;
const SEARCH_LIMIT = 8;

/** Toggled by the login form, so the sign-in flow can be exercised for real. */
let signedIn = true;

export function setMockSignedIn(value: boolean): void {
  signedIn = value;
}

function unauthorized() {
  return HttpResponse.json(
    {
      type: 'about:blank',
      title: 'Unauthorized',
      status: HTTP_UNAUTHORIZED,
      detail: 'No session cookie.',
      code: 'AUTH_INVALID',
    },
    { status: HTTP_UNAUTHORIZED, headers: { 'content-type': 'application/problem+json' } },
  );
}

export const handlers = [
  // The buckets / bucket-settings / object-browser endpoints. First in the array
  // because MSW answers with the first match, and these are the stateful versions
  // of `/buckets`, every bucket sub-resource and every object endpoint
  // (src/mocks/bucketState.ts holds the inventory they mutate).
  ...bucketHandlers,
  ...objectHandlers,
  ...settingsHandlers,

  // The bulk-jobs and IAM (S3 users, groups, policies, access keys) endpoints,
  // stateful for the same reason: those pages are flows, not screenshots.
  ...jobHandlers,
  ...iamHandlers,

  // The overview / first-run / servers / quotas pages' endpoints. These are the
  // stateful versions of `/servers` and `/dashboard`.
  ...pageHandlers,

  http.get(`${base}/auth/me`, () => (signedIn ? HttpResponse.json(mockMe) : unauthorized())),

  http.post(`${base}/auth/login`, async ({ request }) => {
    const body = (await request.json()) as { username?: string; password?: string };
    // Any non-empty pair signs in; an empty password shows the real error path.
    if (!body.username || !body.password) return unauthorized();
    signedIn = true;
    return HttpResponse.json({ user: mockMe });
  }),

  http.post(`${base}/auth/logout`, () => {
    signedIn = false;
    return new HttpResponse(null, { status: HTTP_NO_CONTENT });
  }),

  http.get(`${base}/servers`, () =>
    HttpResponse.json({ items: mockServers, total: mockServers.length }),
  ),

  http.get(`${base}/buckets`, () =>
    HttpResponse.json({
      items: mockBuckets,
      total: mockBuckets.length,
      summary: {
        buckets: mockBuckets.length,
        sizeBytes: mockBuckets.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
        objects: mockBuckets.reduce((sum, item) => sum + (item.objects ?? 0), 0),
        withQuota: mockBuckets.filter((item) => item.quota !== null).length,
        nearQuota: 2,
        public: 0,
      },
    }),
  ),

  http.get(`${base}/dashboard`, () => HttpResponse.json(mockDashboard)),
  http.get(`${base}/settings`, () => HttpResponse.json(mockSettings)),

  http.get(`${base}/jobs`, () =>
    HttpResponse.json({
      items: mockJobs,
      total: mockJobs.length,
      counts: { active: mockJobs.length, scheduled: 0, history: 0 },
    }),
  ),

  http.get(`${base}/iam/access-keys`, () =>
    HttpResponse.json({
      items: mockAccessKeys,
      total: mockAccessKeys.length,
      counts: { all: mockAccessKeys.length, active: 1, expiring: 1, disabled: 0 },
      unavailable: [],
    }),
  ),

  http.get(`${base}/notifications`, ({ request }) => {
    const unreadOnly = new URL(request.url).searchParams.get('unread') === 'true';
    const items = unreadOnly ? mockNotifications.filter((item) => !item.read) : mockNotifications;
    return HttpResponse.json({
      items,
      unread: mockNotifications.filter((item) => !item.read).length,
    });
  }),

  http.post(
    `${base}/notifications/read`,
    () => new HttpResponse(null, { status: HTTP_NO_CONTENT }),
  ),

  http.get(`${base}/search`, ({ request }) => {
    const term = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
    const items = mockSearchResults
      .filter(
        (result) =>
          result.label.toLowerCase().includes(term) || result.sublabel.toLowerCase().includes(term),
      )
      .slice(0, SEARCH_LIMIT);
    return HttpResponse.json({ items } satisfies SearchResponse);
  }),

  // The SSE stream: answered with an open, empty stream so the shell's
  // EventSource connects instead of retrying forever in the console.
  http.get(`${base}/events`, () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': mock stream\n\n'));
      },
    });
    return new HttpResponse(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }),
];
