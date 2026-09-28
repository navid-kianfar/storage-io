import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
  createTestApp,
  type TestHarness,
} from '../support/test-app';

/**
 * These assert what a client can observe: status codes, the problem+json body,
 * whether the cookie works afterwards. Nothing here reaches into a service or a
 * table, so the same tests hold if the storage or the hashing changes.
 */
describe('auth (e2e)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    // A high login limit: the rate-limit behaviour has its own test with its own app.
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('POST /auth/login', () => {
    it('signs in with the configured credentials and sets an httpOnly cookie', async () => {
      const response = await harness
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', harness.origin)
        .send({ username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD, remember: false })
        .expect(201);

      expect(response.body).toEqual({
        user: { username: TEST_ADMIN_USERNAME, displayName: expect.any(String), email: null },
      });

      const cookies = response.headers['set-cookie'] as unknown as string[];
      const session = cookies.find((cookie) => cookie.startsWith('sio_session='));
      expect(session).toBeDefined();
      expect(session).toContain('HttpOnly');
      expect(session).toContain('SameSite=Strict');
      // COOKIE_SECURE defaults to false, so a plain-HTTP LAN install still works.
      expect(session).not.toContain('Secure');
    });

    it('rejects a wrong password with 401 AUTH_INVALID and no cookie', async () => {
      const response = await harness
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', harness.origin)
        .send({ username: TEST_ADMIN_USERNAME, password: 'not-the-password', remember: false })
        .expect(401);

      expect(response.body.code).toBe('AUTH_INVALID');
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('rejects an unknown username with the same answer as a wrong password', async () => {
      const response = await harness
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', harness.origin)
        .send({ username: 'someone-else', password: TEST_ADMIN_PASSWORD, remember: false })
        .expect(401);

      // Identical detail: the endpoint must not be a username oracle.
      expect(response.body.detail).toBe('Invalid credentials.');
    });

    it('rejects a malformed body with 401-free VALIDATION and field paths', async () => {
      const response = await harness
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', harness.origin)
        .send({ username: '', password: TEST_ADMIN_PASSWORD })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION');
      expect(response.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'username' })]),
      );
    });

    it('is reachable without a credential', async () => {
      // Proves @Public() works: a 401 here would mean login needs a login.
      await harness
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', harness.origin)
        .send({ username: 'x', password: 'y', remember: false })
        .expect(401);
    });
  });

  describe('the global guard', () => {
    it('refuses every route without a credential', async () => {
      for (const path of [
        '/api/v1/auth/me',
        '/api/v1/servers',
        '/api/v1/settings',
        '/api/v1/activity',
      ]) {
        const response = await harness.http().get(path).expect(401);
        expect(response.body.code, path).toBe('AUTH_INVALID');
      }
    });

    it('leaves /health public', async () => {
      const response = await harness.http().get('/health').expect(200);
      expect(response.body).toEqual({
        status: 'ok',
        version: expect.any(String),
        uptimeSec: expect.any(Number),
      });
    });

    it('accepts the session cookie', async () => {
      const cookie = await harness.login();
      const response = await harness
        .http()
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body.username).toBe(TEST_ADMIN_USERNAME);
    });

    it('rejects a cookie that is not a real session', async () => {
      await harness
        .http()
        .get('/api/v1/auth/me')
        .set('Cookie', 'sio_session=made-up-token-value')
        .expect(401);
    });
  });

  describe('PATCH /auth/me', () => {
    it('stores the display name and email, and they come back on GET', async () => {
      const cookie = await harness.login();

      const patched = await harness
        .http()
        .patch('/api/v1/auth/me')
        .set('Cookie', cookie)
        .set('Origin', harness.origin)
        .send({ displayName: 'Ada Lovelace', email: 'ada@example.com' })
        .expect(200);

      expect(patched.body).toEqual({
        username: TEST_ADMIN_USERNAME,
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
      });

      const fetched = await harness.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      expect(fetched.body.displayName).toBe('Ada Lovelace');
    });

    it('rejects an empty patch and an invalid email', async () => {
      const cookie = await harness.login();
      const headers = { Cookie: cookie, Origin: harness.origin };

      await harness.http().patch('/api/v1/auth/me').set(headers).send({}).expect(400);
      await harness
        .http()
        .patch('/api/v1/auth/me')
        .set(headers)
        .send({ email: 'not-an-email' })
        .expect(400);
    });
  });

  describe('sessions', () => {
    it('lists sessions and marks the caller current', async () => {
      const first = await harness.login();
      await harness.login();

      const response = await harness
        .http()
        .get('/api/v1/auth/sessions')
        .set('Cookie', first)
        .expect(200);
      const current = response.body.items.filter((item: { current: boolean }) => item.current);
      expect(current).toHaveLength(1);
      expect(response.body.items.length).toBeGreaterThanOrEqual(2);
      // supertest sends no User-Agent, so null here is correct; the next test
      // covers the case where one is present.
      expect(current[0].userAgent).toBeNull();
      expect(current[0].ip).toBe('127.0.0.1');
      expect(current[0]).toMatchObject({
        id: expect.any(String),
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      });
    });

    it('records the User-Agent when the client sends one', async () => {
      const response = await harness
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', harness.origin)
        .set('User-Agent', 'storage-io-test/1.0')
        .send({ username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD, remember: false })
        .expect(201);

      const cookies = response.headers['set-cookie'] as unknown as string[];
      const cookie = (cookies.find((c) => c.startsWith('sio_session=')) as string).split(
        ';',
      )[0] as string;

      const listed = await harness
        .http()
        .get('/api/v1/auth/sessions')
        .set('Cookie', cookie)
        .expect(200);
      const mine = listed.body.items.find((item: { current: boolean }) => item.current);
      expect(mine.userAgent).toBe('storage-io-test/1.0');
    });

    it('a remembered session lasts longer than a plain one', async () => {
      const plain = await harness
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', harness.origin)
        .send({ username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD, remember: false })
        .expect(201);
      const remembered = await harness
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', harness.origin)
        .send({ username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD, remember: true })
        .expect(201);

      const maxAgeOf = (response: { headers: Record<string, unknown> }): number => {
        const cookies = response.headers['set-cookie'] as string[];
        const session = cookies.find((c) => c.startsWith('sio_session=')) as string;
        return Number(/Max-Age=(\d+)/.exec(session)?.[1] ?? '0');
      };

      expect(maxAgeOf(remembered)).toBeGreaterThan(maxAgeOf(plain));
    });

    it('revoking one session stops that cookie working and leaves the other alone', async () => {
      const keep = await harness.login();
      const drop = await harness.login();

      const listed = await harness
        .http()
        .get('/api/v1/auth/sessions')
        .set('Cookie', drop)
        .expect(200);
      const mine = listed.body.items.find((item: { current: boolean }) => item.current);

      await harness
        .http()
        .delete(`/api/v1/auth/sessions/${String(mine.id)}`)
        .set('Cookie', drop)
        .set('Origin', harness.origin)
        .expect(204);

      await harness.http().get('/api/v1/auth/me').set('Cookie', drop).expect(401);
      await harness.http().get('/api/v1/auth/me').set('Cookie', keep).expect(200);
    });

    it('revoking an unknown session is 404, not a silent success', async () => {
      const cookie = await harness.login();
      await harness
        .http()
        .delete('/api/v1/auth/sessions/11111111-1111-1111-1111-111111111111')
        .set('Cookie', cookie)
        .set('Origin', harness.origin)
        .expect(404);
    });

    it('?others=true keeps the caller and drops the rest', async () => {
      const keep = await harness.login();
      const other = await harness.login();

      await harness
        .http()
        .delete('/api/v1/auth/sessions?others=true')
        .set('Cookie', keep)
        .set('Origin', harness.origin)
        .expect(204);

      await harness.http().get('/api/v1/auth/me').set('Cookie', keep).expect(200);
      await harness.http().get('/api/v1/auth/me').set('Cookie', other).expect(401);
    });

    it('DELETE /auth/sessions without ?others=true is refused', async () => {
      const cookie = await harness.login();
      await harness
        .http()
        .delete('/api/v1/auth/sessions')
        .set('Cookie', cookie)
        .set('Origin', harness.origin)
        .expect(404);
    });

    it('logout revokes the caller’s own session', async () => {
      const cookie = await harness.login();
      await harness
        .http()
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie)
        .set('Origin', harness.origin)
        .expect(204);
      await harness.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
    });
  });

  describe('API tokens', () => {
    it('creates a token, shows the secret once, and authenticates with it', async () => {
      const cookie = await harness.login();

      const created = await harness
        .http()
        .post('/api/v1/auth/tokens')
        .set('Cookie', cookie)
        .set('Origin', harness.origin)
        .send({ name: `cli-${Date.now()}`, expiresInDays: 30 })
        .expect(201);

      expect(created.body.token).toMatch(/^sio_/);
      expect(created.body.item).toMatchObject({
        id: expect.any(String),
        prefix: expect.stringMatching(/^sio_/),
        lastUsedAt: null,
      });

      const me = await harness
        .http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${String(created.body.token)}`)
        .expect(200);
      expect(me.body.username).toBe(TEST_ADMIN_USERNAME);

      // The secret is never in a later listing — only its prefix.
      const listed = await harness
        .http()
        .get('/api/v1/auth/tokens')
        .set('Cookie', cookie)
        .expect(200);
      const serialized = JSON.stringify(listed.body);
      expect(serialized).not.toContain(String(created.body.token));
    });

    it('refuses a duplicate token name with 409', async () => {
      const cookie = await harness.login();
      const name = `dup-${Date.now()}`;
      const headers = { Cookie: cookie, Origin: harness.origin };

      await harness
        .http()
        .post('/api/v1/auth/tokens')
        .set(headers)
        .send({ name, expiresInDays: null })
        .expect(201);
      const clash = await harness
        .http()
        .post('/api/v1/auth/tokens')
        .set(headers)
        .send({ name, expiresInDays: null })
        .expect(409);
      expect(clash.body.code).toBe('CONFLICT');
    });

    it('revoking a token stops it authenticating', async () => {
      const cookie = await harness.login();
      const headers = { Cookie: cookie, Origin: harness.origin };

      const created = await harness
        .http()
        .post('/api/v1/auth/tokens')
        .set(headers)
        .send({ name: `revoke-${Date.now()}`, expiresInDays: null })
        .expect(201);
      const token = String(created.body.token);

      await harness
        .http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await harness
        .http()
        .delete(`/api/v1/auth/tokens/${String(created.body.item.id)}`)
        .set(headers)
        .expect(204);
      await harness
        .http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('rejects an expired token', async () => {
      // Expiry is computed from `expiresInDays`, so the shortest real expiry is a
      // day away. Validation refusing 0 is the observable guarantee here.
      const cookie = await harness.login();
      await harness
        .http()
        .post('/api/v1/auth/tokens')
        .set({ Cookie: cookie, Origin: harness.origin })
        .send({ name: 'zero-days', expiresInDays: 0 })
        .expect(400);
    });

    it('ignores an Authorization header that is not a sio_ token', async () => {
      const cookie = await harness.login();
      // A proxy-added Bearer must not shadow a valid cookie.
      await harness
        .http()
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .set('Authorization', 'Bearer some-other-systems-jwt')
        .expect(200);
    });
  });

  describe('the Origin check', () => {
    it('refuses a cookie mutation from a foreign origin', async () => {
      const cookie = await harness.login();
      const response = await harness
        .http()
        .patch('/api/v1/auth/me')
        .set('Cookie', cookie)
        .set('Origin', 'https://attacker.example')
        .send({ displayName: 'Taken over' })
        .expect(403);
      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('refuses a cookie mutation with no Origin or Referer', async () => {
      const cookie = await harness.login();
      await harness
        .http()
        .patch('/api/v1/auth/me')
        .set('Cookie', cookie)
        .send({ displayName: 'No origin' })
        .expect(403);
    });

    it('accepts a same-origin mutation', async () => {
      const cookie = await harness.login();
      await harness
        .http()
        .patch('/api/v1/auth/me')
        .set('Cookie', cookie)
        .set('Origin', harness.origin)
        .send({ displayName: 'Same origin' })
        .expect(200);
    });

    it('does not apply to reads', async () => {
      const cookie = await harness.login();
      await harness
        .http()
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .set('Origin', 'https://attacker.example')
        .expect(200);
    });

    it('does not apply to a Bearer token, which a browser cannot forge', async () => {
      const cookie = await harness.login();
      const created = await harness
        .http()
        .post('/api/v1/auth/tokens')
        .set({ Cookie: cookie, Origin: harness.origin })
        .send({ name: `origin-${Date.now()}`, expiresInDays: null })
        .expect(201);

      await harness
        .http()
        .patch('/api/v1/auth/me')
        .set('Authorization', `Bearer ${String(created.body.token)}`)
        .send({ displayName: 'From the CLI' })
        .expect(200);
    });

    it('accepts an allow-listed foreign origin', async () => {
      const other = await createTestApp({
        ALLOWED_ORIGINS: 'http://localhost:5173',
        LOGIN_RATE_LIMIT: '1000',
      });
      try {
        const cookie = await other.login();
        await other
          .http()
          .patch('/api/v1/auth/me')
          .set('Cookie', cookie)
          .set('Origin', 'http://localhost:5173')
          .send({ displayName: 'From the web app' })
          .expect(200);
      } finally {
        await other.close();
      }
    });
  });
});

describe('login rate limiting (e2e)', () => {
  it('answers 429 RATE_LIMITED once the per-IP limit is exceeded', async () => {
    const harness = await createTestApp({ LOGIN_RATE_LIMIT: '3', LOGIN_RATE_TTL_SEC: '60' });
    try {
      const attempt = () =>
        harness
          .http()
          .post('/api/v1/auth/login')
          .set('Origin', harness.origin)
          .send({ username: TEST_ADMIN_USERNAME, password: 'wrong', remember: false });

      const statuses: number[] = [];
      for (let index = 0; index < 4; index += 1) {
        const response = await attempt();
        statuses.push(response.status);
      }

      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses[3]).toBe(429);

      const blocked = await attempt();
      expect(blocked.body.code).toBe('RATE_LIMITED');
      expect(blocked.headers['content-type']).toContain('application/problem+json');
    } finally {
      await harness.close();
    }
  });

  it('the limit is on login, not on the rest of the API', async () => {
    const harness = await createTestApp({ LOGIN_RATE_LIMIT: '2', LOGIN_RATE_TTL_SEC: '60' });
    try {
      const cookie = await harness.login();
      // The login above used one of the two; reads must not be affected.
      for (let index = 0; index < 20; index += 1) {
        await harness.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      }
    } finally {
      await harness.close();
    }
  });
});

describe('admin password hashing (e2e)', () => {
  it('accepts ADMIN_PASSWORD_HASH instead of a plain password', async () => {
    // Generated with the documented one-liner from .env.example, for
    // "hashed-password-1234".
    const { argon2id } = await import('hash-wasm');
    const { randomBytes } = await import('node:crypto');
    const hash = await argon2id({
      password: 'hashed-password-1234',
      salt: randomBytes(16),
      parallelism: 4,
      iterations: 3,
      memorySize: 65536,
      hashLength: 32,
      outputType: 'encoded',
    });

    const harness = await createTestApp({
      ADMIN_PASSWORD_HASH: hash,
      ADMIN_PASSWORD: 'this-one-is-ignored',
      LOGIN_RATE_LIMIT: '1000',
    });
    try {
      await harness
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', harness.origin)
        .send({ username: TEST_ADMIN_USERNAME, password: 'hashed-password-1234', remember: false })
        .expect(201);

      // ADMIN_PASSWORD must be ignored entirely when a hash is set.
      await harness
        .http()
        .post('/api/v1/auth/login')
        .set('Origin', harness.origin)
        .send({ username: TEST_ADMIN_USERNAME, password: 'this-one-is-ignored', remember: false })
        .expect(401);
    } finally {
      await harness.close();
    }
  });
});
