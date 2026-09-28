import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOTIFICATION_RULE_KEYS, SETTINGS_DEFAULTS } from '@storage-io/contracts';
import { createTestApp, type TestHarness } from '../support/test-app';

/** Settings, notifications, the SSE stream and the allowed-networks middleware. */
describe('platform (e2e)', () => {
  let harness: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();
  });

  afterAll(async () => {
    await harness.close();
  });

  const auth = () => ({ Cookie: cookie, Origin: harness.origin });

  describe('GET /settings', () => {
    it('returns every section with the documented defaults', async () => {
      const response = await harness
        .http()
        .get('/api/v1/settings')
        .set('Cookie', cookie)
        .expect(200);

      expect(Object.keys(response.body).sort()).toEqual(Object.keys(SETTINGS_DEFAULTS).sort());
      expect(response.body.health).toEqual(SETTINGS_DEFAULTS.health);
      expect(response.body.retention).toEqual(SETTINGS_DEFAULTS.retention);
      expect(response.body.transfers.importUrlMaxMb).toBe(
        SETTINGS_DEFAULTS.transfers.importUrlMaxMb,
      );
      expect(Object.keys(response.body.notifications.rules).sort()).toEqual(
        [...NOTIFICATION_RULE_KEYS].sort(),
      );
    });

    it('omits every write-only secret', async () => {
      // Seed all three, then confirm none comes back.
      await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({
          notifications: {
            email: { password: 'smtp-password' },
            webhook: { secret: 'webhook-signing-secret' },
            telegram: { botToken: 'telegram-bot-token' },
          },
        })
        .expect(200);

      const response = await harness
        .http()
        .get('/api/v1/settings')
        .set('Cookie', cookie)
        .expect(200);
      const serialized = JSON.stringify(response.body);

      expect(serialized).not.toContain('smtp-password');
      expect(serialized).not.toContain('webhook-signing-secret');
      expect(serialized).not.toContain('telegram-bot-token');
      expect(response.body.notifications.email).not.toHaveProperty('password');
      expect(response.body.notifications.webhook).not.toHaveProperty('secret');
      expect(response.body.notifications.telegram).not.toHaveProperty('botToken');
    });
  });

  describe('PATCH /settings', () => {
    it('merges one field without resetting its siblings', async () => {
      const patched = await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({ health: { latencyWarnMs: 1200 } })
        .expect(200);

      expect(patched.body.health.latencyWarnMs).toBe(1200);
      expect(patched.body.health.defaultIntervalSec).toBe(
        SETTINGS_DEFAULTS.health.defaultIntervalSec,
      );
      expect(patched.body.retention).toEqual(SETTINGS_DEFAULTS.retention);
    });

    it('persists across a read', async () => {
      await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({ region: { timezone: 'Europe/Istanbul', sizeUnits: 'decimal' } })
        .expect(200);

      const read = await harness.http().get('/api/v1/settings').set('Cookie', cookie).expect(200);
      expect(read.body.region.timezone).toBe('Europe/Istanbul');
      expect(read.body.region.sizeUnits).toBe('decimal');
      // Untouched keys keep their defaults.
      expect(read.body.region.calendar).toBe(SETTINGS_DEFAULTS.region.calendar);
    });

    it('replaces an array wholesale rather than merging it', async () => {
      // 127.0.0.1 stays in the list throughout: a list that excludes the caller
      // locks this harness out of its own API on the very next request, which is
      // the middleware working and would make the rest of the file unrunnable.
      await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({ security: { allowedNetworks: ['127.0.0.1/32', '10.0.0.0/8'] } })
        .expect(200);

      const shrunk = await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({ security: { allowedNetworks: ['127.0.0.1/32'] } })
        .expect(200);

      // A merged array would make removing an entry impossible.
      expect(shrunk.body.security.allowedNetworks).toEqual(['127.0.0.1/32']);

      const cleared = await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({ security: { allowedNetworks: [] } })
        .expect(200);
      expect(cleared.body.security.allowedNetworks).toEqual([]);
    });

    it('rejects an empty patch and out-of-range values', async () => {
      await harness.http().patch('/api/v1/settings').set(auth()).send({}).expect(400);
      await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({ health: { latencyWarnMs: 0 } })
        .expect(400);
      await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({ transfers: { partSizeMb: 32 } })
        .expect(400);
    });

    it('rejects an allowed-networks entry that is not a CIDR or address', async () => {
      const response = await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({ security: { allowedNetworks: ['not-a-network'] } })
        .expect(400);
      expect(response.body.code).toBe('VALIDATION');
    });
  });

  describe('POST /settings/notifications/test', () => {
    it('says the channel is disabled when it is', async () => {
      const response = await harness
        .http()
        .post('/api/v1/settings/notifications/test')
        .set(auth())
        .send({ channel: 'email' })
        .expect(201);

      expect(response.body).toEqual({ ok: false, detail: expect.stringContaining('disabled') });
    });

    it('reports the transport as not implemented once the channel is enabled', async () => {
      // The delivery drivers are a later task; the interface and the routing are
      // what exist today, and this is what proves the wiring reaches them.
      await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({ notifications: { webhook: { enabled: true, url: 'https://example.com/hook' } } })
        .expect(200);

      const response = await harness
        .http()
        .post('/api/v1/settings/notifications/test')
        .set(auth())
        .send({ channel: 'webhook' })
        .expect(201);

      expect(response.body.ok).toBe(false);
      expect(response.body.detail).toMatch(/not implemented/i);
    });

    it('accepts every documented channel and refuses anything else', async () => {
      for (const channel of ['email', 'webhook', 'telegram', 'syslog']) {
        await harness
          .http()
          .post('/api/v1/settings/notifications/test')
          .set(auth())
          .send({ channel })
          .expect(201);
      }
      await harness
        .http()
        .post('/api/v1/settings/notifications/test')
        .set(auth())
        .send({ channel: 'carrier-pigeon' })
        .expect(400);
    });
  });

  describe('notifications', () => {
    it('lists the new-device notification login raised, and marking it read sticks', async () => {
      const listed = await harness
        .http()
        .get('/api/v1/notifications')
        .set('Cookie', cookie)
        .expect(200);
      expect(listed.body.unread).toBeGreaterThanOrEqual(1);
      const newDevice = listed.body.items.find((n: { title: string }) =>
        n.title.includes('new device'),
      );
      expect(newDevice).toBeDefined();
      expect(newDevice.read).toBe(false);

      await harness
        .http()
        .post('/api/v1/notifications/read')
        .set(auth())
        .send({ ids: [newDevice.id] })
        .expect(204);

      const after = await harness
        .http()
        .get('/api/v1/notifications')
        .set('Cookie', cookie)
        .expect(200);
      const same = after.body.items.find((n: { id: string }) => n.id === newDevice.id);
      expect(same.read).toBe(true);
    });

    it('?unread=true hides what has been read', async () => {
      await harness
        .http()
        .post('/api/v1/notifications/read')
        .set(auth())
        .send({ ids: 'all' })
        .expect(204);

      const response = await harness
        .http()
        .get('/api/v1/notifications?unread=true')
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body.items).toEqual([]);
      expect(response.body.unread).toBe(0);
    });

    it('rejects a body that is neither an id list nor "all"', async () => {
      await harness
        .http()
        .post('/api/v1/notifications/read')
        .set(auth())
        .send({ ids: 'everything' })
        .expect(400);
    });
  });

  describe('activity', () => {
    it('paginates, and the total counts the whole filtered set', async () => {
      const first = await harness
        .http()
        .get('/api/v1/activity?page=1&pageSize=2')
        .set('Cookie', cookie)
        .expect(200);

      expect(first.body.items.length).toBeLessThanOrEqual(2);
      expect(first.body.total).toBeGreaterThanOrEqual(first.body.items.length);

      const second = await harness
        .http()
        .get('/api/v1/activity?page=2&pageSize=2')
        .set('Cookie', cookie)
        .expect(200);
      expect(second.body.total).toBe(first.body.total);
      if (first.body.items.length === 2 && second.body.items.length > 0) {
        expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
      }
    });

    it('caps pageSize rather than letting a client ask for everything', async () => {
      await harness
        .http()
        .get('/api/v1/activity?pageSize=100000')
        .set('Cookie', cookie)
        .expect(400);
    });

    it('fetches one event by id, and 404s for an unknown one', async () => {
      const listed = await harness
        .http()
        .get('/api/v1/activity?pageSize=1')
        .set('Cookie', cookie)
        .expect(200);
      const id = String(listed.body.items[0].id);

      const one = await harness
        .http()
        .get(`/api/v1/activity/${id}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(one.body.id).toBe(id);

      await harness
        .http()
        .get('/api/v1/activity/11111111-1111-1111-1111-111111111111')
        .set('Cookie', cookie)
        .expect(404);
    });

    it('exports CSV with the documented header and a BOM', async () => {
      const response = await harness
        .http()
        .get('/api/v1/activity/export.csv')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.text.startsWith('﻿')).toBe(true);

      const header = response.text.slice(1).split('\r\n')[0];
      expect(header).toBe(
        'at,category,action,title,actorType,actorName,target,serverName,ip,result,requestId,details',
      );
    });

    it('export.csv is not shadowed by the :id route', async () => {
      // Declared before `:id`; if that order broke, this would be a 404.
      await harness.http().get('/api/v1/activity/export.csv').set('Cookie', cookie).expect(200);
    });

    it('quotes a cell containing a comma or a quote', async () => {
      const response = await harness
        .http()
        .get('/api/v1/activity/export.csv')
        .set('Cookie', cookie)
        .expect(200);

      // The details column is JSON, which always contains commas and quotes.
      const rows = response.text
        .slice(1)
        .split('\r\n')
        .filter((row) => row.length > 0);
      expect(rows.length).toBeGreaterThan(1);
      expect(rows[1]).toMatch(/,"\{""method""/);
    });

    it('attributes a successful login to the admin, not to the system actor', async () => {
      const response = await harness
        .http()
        .get('/api/v1/activity?category=auth&pageSize=50')
        .set('Cookie', cookie)
        .expect(200);

      const signIn = response.body.items.find(
        (event: { action: string; result: string }) =>
          event.action === 'auth.login' && event.result === 'success',
      );
      expect(signIn).toBeDefined();
      expect(signIn.actor).toEqual({ type: 'admin', name: 'test-admin' });
    });

    it('records a failed sign-in under its own title', async () => {
      await harness
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', harness.origin)
        .send({ username: 'test-admin', password: 'definitely-wrong', remember: false })
        .expect(401);

      const response = await harness
        .http()
        .get('/api/v1/activity?category=auth&pageSize=10')
        .set('Cookie', cookie)
        .expect(200);

      const failed = response.body.items.find(
        (event: { action: string; result: string }) =>
          event.action === 'auth.login' && event.result !== 'success',
      );
      expect(failed).toBeDefined();
      expect(failed.title).toBe('Failed sign-in attempt');
      expect(failed.details.errorCode).toBe('AUTH_INVALID');
    });
  });

  describe('GET /events (SSE)', () => {
    it('refuses an unauthenticated client with problem+json, not a stream', async () => {
      const response = await harness.http().get('/api/v1/events').expect(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body.code).toBe('AUTH_INVALID');
    });

    it('opens an event stream for an authenticated client', async () => {
      // supertest would wait for the stream to end, so the socket is read
      // directly and closed once the headers have arrived.
      const { origin } = harness;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      try {
        const response = await fetch(`${origin}/api/v1/events`, {
          headers: { Cookie: cookie, Accept: 'text/event-stream' },
          signal: controller.signal,
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        // Compression is disabled for this path, or events would arrive in bursts.
        expect(response.headers.get('content-encoding')).toBeNull();
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    });
  });

  describe('the allowed-networks middleware', () => {
    it('rejects a request from outside the list and keeps /health reachable', async () => {
      const locked = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
      try {
        const lockedCookie = await locked.login();

        // 127.0.0.1 is the test client, so a list that excludes it locks us out.
        await locked
          .http()
          .patch('/api/v1/settings')
          .set({ Cookie: lockedCookie, Origin: locked.origin })
          .send({ security: { allowedNetworks: ['203.0.113.0/24'] } })
          .expect(200);

        const blocked = await locked
          .http()
          .get('/api/v1/auth/me')
          .set('Cookie', lockedCookie)
          .expect(403);
        expect(blocked.body.code).toBe('FORBIDDEN');
        expect(blocked.headers['content-type']).toContain('application/problem+json');

        // The escape hatch: /health stays reachable so the operator can tell the
        // API is alive rather than down.
        await locked.http().get('/health').expect(200);
      } finally {
        await locked.close();
      }
    });

    it('allows everything when the list is empty', async () => {
      await harness.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
    });
  });

  describe('cross-cutting behaviour', () => {
    it('echoes a client-supplied request id and puts it in the problem body', async () => {
      const response = await harness
        .http()
        .get('/api/v1/servers/missing')
        .set('Cookie', cookie)
        .set('X-Request-Id', 'my-own-request-id-123')
        .expect(404);

      expect(response.headers['x-request-id']).toBe('my-own-request-id-123');
      expect(response.body.requestId).toBe('my-own-request-id-123');
    });

    it('ignores an implausible client-supplied request id', async () => {
      const response = await harness
        .http()
        .get('/api/v1/servers/missing')
        .set('Cookie', cookie)
        .set('X-Request-Id', 'short')
        .expect(404);

      expect(response.headers['x-request-id']).not.toBe('short');
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('sets the helmet headers', async () => {
      const response = await harness.http().get('/health').expect(200);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('answers 404 in problem+json for an unknown route', async () => {
      const response = await harness
        .http()
        .get('/api/v1/not-a-real-route')
        .set('Cookie', cookie)
        .expect(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('serves /health without the version prefix, and not with it', async () => {
      await harness.http().get('/health').expect(200);
      await harness.http().get('/api/v1/health').expect(404);
    });
  });
});
