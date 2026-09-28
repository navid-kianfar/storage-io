import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_ADMIN_USERNAME, createTestApp, type TestHarness } from '../support/test-app';

/**
 * The boundary behaviours a client can forge from the outside, asserted the way a
 * client sees them.
 *
 * Every case here is a fix for something that was wrong: `X-Forwarded-For` was
 * believed from anybody, a stored HTML object came back as renderable HTML, the
 * app shipped with no content policy at all, and a search for `100%` matched
 * every row.
 */

const FORGED_IP = '203.0.113.99';

describe('security boundaries (e2e)', () => {
  describe('TRUST_PROXY off (the default)', () => {
    let harness: TestHarness;
    let cookie: string;

    beforeAll(async () => {
      harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
      cookie = await harness.login();
    });

    afterAll(async () => {
      await harness.close();
    });

    it('records the socket address in the activity trail, not the forged header', async () => {
      await harness
        .http()
        .patch('/api/v1/auth/me')
        .set({ Cookie: cookie, Origin: harness.origin })
        .set('X-Forwarded-For', FORGED_IP)
        .send({ displayName: 'Trust proxy off' })
        .expect(200);

      const activity = await harness
        .http()
        .get('/api/v1/activity?limit=20')
        .set('Cookie', cookie)
        .expect(200);

      const entry = activity.body.items.find(
        (item: { action: string }) => item.action === 'auth.profile.update',
      );
      expect(entry).toBeDefined();
      expect(entry.ip).not.toBe(FORGED_IP);
      expect(entry.ip).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
    });

    it('still blocks a request the allowed-networks list excludes, however it claims to arrive', async () => {
      const locked = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
      try {
        const lockedCookie = await locked.login();
        await locked
          .http()
          .patch('/api/v1/settings')
          .set({ Cookie: lockedCookie, Origin: locked.origin })
          .send({ security: { allowedNetworks: [`${FORGED_IP}/32`] } })
          .expect(200);

        // Claiming to be the one allowed address must change nothing.
        const blocked = await locked
          .http()
          .get('/api/v1/auth/me')
          .set('Cookie', lockedCookie)
          .set('X-Forwarded-For', FORGED_IP)
          .expect(403);
        expect(blocked.body.code).toBe('FORBIDDEN');
      } finally {
        await locked.close();
      }
    });

    it('still throttles login when every attempt claims a different address', async () => {
      const throttled = await createTestApp({ LOGIN_RATE_LIMIT: '3', LOGIN_RATE_TTL_SEC: '60' });
      try {
        const attempt = (index: number) =>
          throttled
            .http()
            .post('/api/v1/auth/login')
            .set('Origin', throttled.origin)
            .set('X-Forwarded-For', `198.51.100.${index}`)
            .send({ username: TEST_ADMIN_USERNAME, password: 'wrong', remember: false });

        const statuses: number[] = [];
        for (let index = 1; index <= 6; index += 1) {
          const response = await attempt(index);
          statuses.push(response.status);
        }
        // A forged per-attempt address would have given every one its own bucket.
        expect(statuses).toContain(429);
      } finally {
        await throttled.close();
      }
    });
  });

  describe('TRUST_PROXY configured', () => {
    it('believes X-Forwarded-For once the proxy in front has been named', async () => {
      const proxied = await createTestApp({ LOGIN_RATE_LIMIT: '1000', TRUST_PROXY: '1' });
      try {
        const proxiedCookie = await proxied.login();

        await proxied
          .http()
          .patch('/api/v1/auth/me')
          .set({ Cookie: proxiedCookie, Origin: proxied.origin })
          .set('X-Forwarded-For', FORGED_IP)
          .send({ displayName: 'Trust proxy on' })
          .expect(200);

        const activity = await proxied
          .http()
          .get('/api/v1/activity?limit=20')
          .set('Cookie', proxiedCookie)
          .expect(200);

        const entry = activity.body.items.find(
          (item: { action: string }) => item.action === 'auth.profile.update',
        );
        expect(entry.ip).toBe(FORGED_IP);
      } finally {
        await proxied.close();
      }
    });
  });

  describe('the content security policy', () => {
    let harness: TestHarness;

    beforeAll(async () => {
      harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    });

    afterAll(async () => {
      await harness.close();
    });

    it('is sent, and confines scripts and framing', async () => {
      const response = await harness.http().get('/health').expect(200);
      const policy = response.headers['content-security-policy'] ?? '';

      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("base-uri 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("connect-src 'self'");
      // The app's own bundle must not be able to be replaced by an inline script.
      expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    });
  });

  describe('search with LIKE metacharacters', () => {
    let harness: TestHarness;
    let cookie: string;

    /**
     * An API token's name becomes the `actorName` of every activity row the token
     * writes, which is the one searchable column a test can put an arbitrary
     * string into through the public API.
     */
    const NAMES = ['pct-100%-done', 'under_score-here', 'back\\slash-here', 'plain-name'] as const;

    beforeAll(async () => {
      harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
      cookie = await harness.login();

      for (const name of NAMES) {
        const created = await harness
          .http()
          .post('/api/v1/auth/tokens')
          .set({ Cookie: cookie, Origin: harness.origin })
          .send({ name, expiresInDays: null })
          .expect(201);

        // One mutating request per token, so each name appears as an actor.
        await harness
          .http()
          .patch('/api/v1/auth/me')
          .set('Authorization', `Bearer ${created.body.token as string}`)
          .send({ displayName: 'Administrator' })
          .expect(200);
      }
    });

    afterAll(async () => {
      await harness.close();
    });

    const search = async (q: string): Promise<readonly { actor: { name: string } }[]> => {
      const response = await harness
        .http()
        .get(`/api/v1/activity?limit=100&q=${encodeURIComponent(q)}`)
        .set('Cookie', cookie)
        .expect(200);
      return response.body.items;
    };

    it('treats % as text rather than as "match anything"', async () => {
      const hits = await search('100%');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((item) => item.actor.name.includes('100%'))).toBe(true);
      // Without an ESCAPE clause the escaped needle matched nothing; without the
      // escaping it matched every row in the table.
      expect(hits.some((item) => item.actor.name === 'plain-name')).toBe(false);
    });

    it('treats _ as text rather than as "match one character"', async () => {
      const hits = await search('under_score');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((item) => item.actor.name.includes('under_score'))).toBe(true);
    });

    it('does not let _ match a different character', async () => {
      expect(await search('underXscore')).toEqual([]);
    });

    it('finds a backslash, which used to match nothing at all', async () => {
      const hits = await search('back\\slash');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((item) => item.actor.name.includes('back\\slash'))).toBe(true);
    });

    it('searches servers, jobs and buckets by the same rule', async () => {
      // No matching rows are needed to prove the statement is well formed: a
      // LIKE whose needle ends in an unpaired backslash is a different query
      // depending on whether the ESCAPE clause is there.
      await harness.http().get('/api/v1/servers?q=a%5C').set('Cookie', cookie).expect(200);
      await harness.http().get('/api/v1/jobs?view=active&q=a%5C').set('Cookie', cookie).expect(200);
      await harness.http().get('/api/v1/buckets?q=100%25').set('Cookie', cookie).expect(200);
    });
  });

  describe('DELETE /auth/sessions?others=true from an API token', () => {
    let harness: TestHarness;

    beforeAll(async () => {
      harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    });

    afterAll(async () => {
      await harness.close();
    });

    it('revokes every session in one go', async () => {
      const cookie = await harness.login();

      const created = await harness
        .http()
        .post('/api/v1/auth/tokens')
        .set({ Cookie: cookie, Origin: harness.origin })
        .send({ name: 'revoke-all', expiresInDays: null })
        .expect(201);
      const token: string = created.body.token;

      // Three more browser sessions beside the one above.
      await harness.login();
      await harness.login();
      await harness.login();

      const before = await harness
        .http()
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(before.body.items.length).toBeGreaterThanOrEqual(4);

      await harness
        .http()
        .delete('/api/v1/auth/sessions?others=true')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const after = await harness
        .http()
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(after.body.items).toEqual([]);

      // And the cookie that was valid a moment ago no longer is.
      await harness.http().get('/api/v1/auth/me').set('Cookie', cookie).expect(401);

      // The token itself is unaffected: it is not a session.
      await harness
        .http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });
  });
});
