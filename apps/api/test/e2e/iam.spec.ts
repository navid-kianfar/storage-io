import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestHarness } from '../support/test-app';

/**
 * The IAM route surface through the real application: validation, authorisation,
 * the aggregated lists, and what happens when a provider cannot do something.
 *
 * Nothing here needs a storage server, which is the point. Two cases only an
 * unreachable endpoint can prove:
 *
 * - **An aggregated list never fails because one server is down.** It answers 200
 *   with the server named in `unavailable`, because an operator with four servers
 *   and one dead one still needs the other three.
 * - **`NOT_SUPPORTED` comes back as a 409 with a code**, not as a 500 from a driver
 *   with a missing method.
 *
 * The same endpoints against live MinIO and SeaweedFS are in `test/it/iam.it.spec.ts`.
 */

/** A closed port: reachable enough to save, dead enough to fail every call. */
const UNREACHABLE = 'http://127.0.0.1:9';

const serverBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'iam-minio',
  provider: 'minio',
  endpoint: UNREACHABLE,
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI-secret-1234',
  options: { pathStyle: true, healthIntervalSec: 3600 },
  ...overrides,
});

const READ_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'ReadReports',
      Effect: 'Allow',
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::reports/*'],
    },
  ],
};

describe('iam (e2e)', () => {
  let harness: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();

    await harness.http().post('/api/v1/servers').set(auth()).send(serverBody()).expect(201);
  });

  afterAll(async () => {
    await harness.close();
  });

  function auth(): Record<string, string> {
    return { Cookie: cookie, Origin: harness.origin };
  }

  describe('authorisation', () => {
    it('refuses every IAM route without a session', async () => {
      const paths = [
        '/api/v1/iam/users',
        '/api/v1/iam/groups',
        '/api/v1/iam/policies',
        '/api/v1/iam/access-keys',
        '/api/v1/iam/users/export.csv',
        '/api/v1/iam/access-keys/export.csv',
      ];

      for (const path of paths) {
        const response = await harness.http().get(path).expect(401);
        expect(response.body.code).toBe('AUTH_INVALID');
      }
    });

    it('refuses a policy simulation without a session', async () => {
      await harness
        .http()
        .post('/api/v1/iam/policies/simulate')
        .send({ document: READ_POLICY, action: 's3:GetObject', resource: 'arn:aws:s3:::reports/x' })
        .expect(401);
    });
  });

  describe('aggregated lists', () => {
    it('answers 200 with the dead server named, rather than failing the whole list', async () => {
      const response = await harness
        .http()
        .get('/api/v1/iam/users')
        .set('Cookie', cookie)
        .expect(200);

      const server = await harness
        .http()
        .get('/api/v1/servers/iam-minio')
        .set('Cookie', cookie)
        .expect(200);

      // A connection test that never reached the endpoint leaves the capabilities at
      // the provider profile, so MinIO still claims `iamUsers`. The aggregate
      // therefore asks it, it fails, and that is exactly the four-servers-one-dead
      // case: the list still answers.
      expect(server.body.capabilities.iamUsers).toBe('supported');
      expect(response.body.items).toEqual([]);
      expect(response.body.total).toBe(0);
      expect(response.body.unavailable).toEqual([
        { serverId: server.body.id, message: expect.any(String) },
      ]);
    });

    it('keeps the provider error out of the unavailable message', async () => {
      const response = await harness
        .http()
        .get('/api/v1/iam/users')
        .set('Cookie', cookie)
        .expect(200);

      const message = String(response.body.unavailable[0].message);
      expect(message).not.toContain('ECONNREFUSED');
      expect(message).not.toContain('127.0.0.1');
    });

    it('answers the access-key list with counts and an empty page', async () => {
      const response = await harness
        .http()
        .get('/api/v1/iam/access-keys')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body).toMatchObject({
        items: [],
        total: 0,
        counts: { all: 0, active: 0, expiring: 0, disabled: 0 },
      });
    });

    it('rejects a page size beyond the contract maximum', async () => {
      const response = await harness
        .http()
        .get('/api/v1/iam/users?pageSize=5000')
        .set('Cookie', cookie)
        .expect(400);

      expect(response.body.code).toBe('VALIDATION');
    });

    it('rejects an unknown status filter', async () => {
      await harness
        .http()
        .get('/api/v1/iam/access-keys?status=nearly')
        .set('Cookie', cookie)
        .expect(400);
    });
  });

  describe('CSV exports', () => {
    it('exports users as CSV with the contract column order', async () => {
      const response = await harness
        .http()
        .get('/api/v1/iam/users/export.csv')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('s3-users.csv');
      expect(response.text).toContain(
        'serverName,provider,name,status,policies,groups,accessKeyCount,createdAt,lastActivityAt',
      );
    });

    it('exports access keys as CSV', async () => {
      const response = await harness
        .http()
        .get('/api/v1/iam/access-keys/export.csv')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.headers['content-disposition']).toContain('access-keys.csv');
      expect(response.text).toContain('accessKeyId,userName,name,status,restricted');
    });
  });

  describe('POST /iam/policies/validate', () => {
    it('accepts a well-formed document and warns about the missing Version', async () => {
      const response = await harness
        .http()
        .post('/api/v1/iam/policies/validate')
        .set(auth())
        .send({ document: { Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] } })
        .expect(201);

      expect(response.body.valid).toBe(true);
      expect(response.body.warnings.join(' ')).toContain('2012-10-17');
      // "Allows everything" is worth saying out loud, not rejecting.
      expect(response.body.warnings.join(' ')).toContain('every action');
      expect(response.body.warnings.join(' ')).toContain('every resource');
    });

    it('names the statement and field that is wrong', async () => {
      const response = await harness
        .http()
        .post('/api/v1/iam/policies/validate')
        .set(auth())
        .send({
          document: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Maybe', Action: 's3:GetObject', Resource: '*' }],
          },
        })
        .expect(201);

      expect(response.body.valid).toBe(false);
      expect(response.body.errors).toEqual([
        { path: 'Statement[0].Effect', message: 'Effect must be "Allow" or "Deny".' },
      ]);
    });

    it('rejects a document that is not an object at all', async () => {
      await harness
        .http()
        .post('/api/v1/iam/policies/validate')
        .set(auth())
        .send({ document: 'Allow everything' })
        .expect(400);
    });
  });

  describe('POST /iam/policies/simulate', () => {
    it('allows a matching action and names the statement that decided', async () => {
      const response = await harness
        .http()
        .post('/api/v1/iam/policies/simulate')
        .set(auth())
        .send({
          document: READ_POLICY,
          action: 's3:GetObject',
          resource: 'arn:aws:s3:::reports/q1.csv',
        })
        .expect(201);

      expect(response.body).toEqual({
        decision: 'allow',
        statementSid: 'ReadReports',
        statementIndex: 0,
      });
    });

    it('implicitly denies an action no statement mentions', async () => {
      const response = await harness
        .http()
        .post('/api/v1/iam/policies/simulate')
        .set(auth())
        .send({
          document: READ_POLICY,
          action: 's3:DeleteObject',
          resource: 'arn:aws:s3:::reports/q1.csv',
        })
        .expect(201);

      expect(response.body).toEqual({
        decision: 'implicit-deny',
        statementSid: null,
        statementIndex: null,
      });
    });

    it('lets an explicit Deny win over an Allow, wherever it sits', async () => {
      const response = await harness
        .http()
        .post('/api/v1/iam/policies/simulate')
        .set(auth())
        .send({
          document: {
            Version: '2012-10-17',
            Statement: [
              { Sid: 'Wide', Effect: 'Allow', Action: 's3:*', Resource: '*' },
              {
                Sid: 'NotSecrets',
                Effect: 'Deny',
                Action: 's3:GetObject',
                Resource: 'arn:aws:s3:::reports/secrets/*',
              },
            ],
          },
          action: 's3:GetObject',
          resource: 'arn:aws:s3:::reports/secrets/pay.csv',
        })
        .expect(201);

      expect(response.body).toMatchObject({ decision: 'deny', statementSid: 'NotSecrets' });
    });

    it('evaluates a condition against the context it was given', async () => {
      const document = {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'FromOffice',
            Effect: 'Allow',
            Action: 's3:GetObject',
            Resource: '*',
            Condition: { IpAddress: { 'aws:SourceIp': '10.0.0.0/24' } },
          },
        ],
      };

      const inside = await harness
        .http()
        .post('/api/v1/iam/policies/simulate')
        .set(auth())
        .send({
          document,
          action: 's3:GetObject',
          resource: 'arn:aws:s3:::reports/x',
          context: { 'aws:SourceIp': '10.0.0.7' },
        })
        .expect(201);
      expect(inside.body.decision).toBe('allow');

      const outside = await harness
        .http()
        .post('/api/v1/iam/policies/simulate')
        .set(auth())
        .send({
          document,
          action: 's3:GetObject',
          resource: 'arn:aws:s3:::reports/x',
          context: { 'aws:SourceIp': '192.168.1.7' },
        })
        .expect(201);
      expect(outside.body.decision).toBe('implicit-deny');
    });

    it('requires an action and a resource', async () => {
      await harness
        .http()
        .post('/api/v1/iam/policies/simulate')
        .set(auth())
        .send({ document: READ_POLICY, action: 's3:GetObject' })
        .expect(400);
    });
  });

  describe('per-server routes against a missing server', () => {
    it('answers NOT_FOUND for every shape of :sid', async () => {
      const requests: readonly (readonly [string, string, unknown])[] = [
        ['get', '/api/v1/servers/ghost/iam/users/alice', undefined],
        ['get', '/api/v1/servers/ghost/iam/policies/readwrite', undefined],
        ['get', '/api/v1/servers/ghost/iam/policies/readwrite/versions', undefined],
      ];

      for (const [, path] of requests) {
        const response = await harness.http().get(path).set('Cookie', cookie).expect(404);
        expect(response.body.code).toBe('NOT_FOUND');
      }
    });

    it('answers NOT_FOUND when creating on a server that is not registered', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers/ghost/iam/users')
        .set(auth())
        .send({ name: 'alice', secret: 'a-secret-1234', policies: [], groups: [], createAccessKey: false })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('request validation on the write paths', () => {
    it('rejects a user with no name', async () => {
      await harness
        .http()
        .post('/api/v1/servers/iam-minio/iam/users')
        .set(auth())
        .send({ name: '', secret: 'a-secret-1234', policies: [], groups: [], createAccessKey: false })
        .expect(400);
    });

    it('rejects a MinIO secret that is too short to be one', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers/iam-minio/iam/users')
        .set(auth())
        .send({ name: 'alice', secret: 'short', policies: [], groups: [], createAccessKey: false })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION');
    });

    it('rejects an empty access-key patch, because it would mean nothing', async () => {
      await harness
        .http()
        .patch('/api/v1/servers/iam-minio/iam/access-keys/AKIA0001')
        .set(auth())
        .send({})
        .expect(400);
    });

    it('rejects a rotation grace period beyond the contract maximum', async () => {
      await harness
        .http()
        .post('/api/v1/servers/iam-minio/iam/access-keys/AKIA0001/rotate')
        .set(auth())
        .send({ graceSeconds: 99_999_999, expiresAt: null })
        .expect(400);
    });

    it('rejects a group with no name', async () => {
      await harness
        .http()
        .post('/api/v1/servers/iam-minio/iam/groups')
        .set(auth())
        .send({ name: '', members: [], policies: [] })
        .expect(400);
    });

    it('rejects a policy PUT whose document is invalid, before reaching the server', async () => {
      const response = await harness
        .http()
        .put('/api/v1/servers/iam-minio/iam/policies/broken')
        .set(auth())
        .send({ document: { Version: '2012-10-17', Statement: [{ Effect: 'Allow' }] } })
        .expect(400);

      // The path of the offending field, which a provider error would not carry.
      expect(response.body.code).toBe('VALIDATION');
      expect(JSON.stringify(response.body.errors)).toContain('Statement[0]');
    });
  });

  describe('CSRF', () => {
    it('refuses a cookie-authenticated write with no Origin', async () => {
      await harness
        .http()
        .post('/api/v1/servers/iam-minio/iam/users')
        .set('Cookie', cookie)
        .send({ name: 'alice', secret: 'a-secret-1234', policies: [], groups: [], createAccessKey: false })
        .expect(403);
    });
  });

  describe('policy versions with no history', () => {
    it('answers an empty list rather than a 404, because the policy may be untouched', async () => {
      const response = await harness
        .http()
        .get('/api/v1/servers/iam-minio/iam/policies/readwrite/versions')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body).toEqual({ items: [] });
    });

    it('answers NOT_FOUND when restoring a version that was never recorded', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers/iam-minio/iam/policies/readwrite/versions/nope/restore')
        .set(auth())
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /servers/:id/rotate-credentials', () => {
    it('refuses a body that is neither mode', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers/iam-minio/rotate-credentials')
        .set(auth())
        .send({ mode: 'whenever' })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION');
    });

    it('requires both halves of a manual rotation', async () => {
      await harness
        .http()
        .post('/api/v1/servers/iam-minio/rotate-credentials')
        .set(auth())
        .send({ mode: 'manual', accessKeyId: 'AKIANEW' })
        .expect(400);
    });

    it('answers NOT_FOUND for a server that is not registered', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers/ghost/rotate-credentials')
        .set(auth())
        .send({ mode: 'auto' })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('does not shadow GET /servers/:id, which still answers', async () => {
      // Two controllers serve `/servers`; the more specific path must not swallow
      // the parameterised one.
      await harness.http().get('/api/v1/servers/iam-minio').set('Cookie', cookie).expect(200);
    });

    it('leaves the stored credentials alone when the new ones cannot be verified', async () => {
      const before = await harness
        .http()
        .get('/api/v1/servers/iam-minio')
        .set('Cookie', cookie)
        .expect(200);

      // The endpoint is a closed port, so verification cannot succeed — and a
      // rotation that cannot be proven must change nothing.
      const response = await harness
        .http()
        .post('/api/v1/servers/iam-minio/rotate-credentials')
        .set(auth())
        .send({ mode: 'manual', accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret-5678' })
        .expect((res) => {
          expect([400, 409, 502, 503]).toContain(res.status);
        });
      expect(JSON.stringify(response.body)).not.toContain('new-secret-5678');

      const after = await harness
        .http()
        .get('/api/v1/servers/iam-minio')
        .set('Cookie', cookie)
        .expect(200);
      expect(after.body.accessKeyId).toBe(before.body.accessKeyId);
      expect(after.body.secretMasked).toBe(before.body.secretMasked);
    });

    it('refuses a provider with no way to create a key', async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'iam-r2', provider: 'r2' }))
        .expect(201);

      const response = await harness
        .http()
        .post('/api/v1/servers/iam-r2/rotate-credentials')
        .set(auth())
        .send({ mode: 'auto' })
        .expect(409);

      expect(response.body.code).toBe('NOT_SUPPORTED');
    });

    it("refuses Garage, because a new key would not carry the old one's permissions", async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(
          serverBody({
            name: 'iam-garage',
            provider: 'garage',
            options: { pathStyle: true, healthIntervalSec: 3600, adminToken: 'garage-token' },
          }),
        )
        .expect(201);

      const response = await harness
        .http()
        .post('/api/v1/servers/iam-garage/rotate-credentials')
        .set(auth())
        .send({ mode: 'auto' })
        .expect(409);

      expect(response.body.code).toBe('NOT_SUPPORTED');
      expect(response.body.detail).toContain('identity');
    });

    it('records the attempt in the activity log, success or failure', async () => {
      const response = await harness
        .http()
        .get('/api/v1/activity?category=servers')
        .set('Cookie', cookie)
        .expect(200);

      const actions = response.body.items.map((item: { action: string }) => item.action);
      expect(actions).toContain('server.rotate-credentials');
      const rotation = response.body.items.find(
        (item: { action: string }) => item.action === 'server.rotate-credentials',
      );
      // A refused rotation is a `warning` (4xx) and a broken one a `failure` (5xx);
      // what matters is that it is never recorded as a success.
      expect(['failure', 'warning']).toContain(rotation.result);
      // No secret may reach the audit trail.
      expect(JSON.stringify(response.body)).not.toContain('new-secret-5678');
    });
  });

  describe('errors from an unreachable provider', () => {
    it('reports a provider failure as PROVIDER_ERROR, with no provider body in it', async () => {
      const response = await harness
        .http()
        .get('/api/v1/servers/iam-minio/iam/users/alice')
        .set('Cookie', cookie)
        .expect((res) => {
          // Either the driver could not reach the admin API (502) or the registry
          // refused because the capability is not configured (409). Both are
          // legitimate; what must not happen is a 500.
          expect([409, 502, 503]).toContain(res.status);
        });

      expect(['PROVIDER_ERROR', 'NOT_SUPPORTED', 'SERVER_OFFLINE']).toContain(response.body.code);
      expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');
      expect(JSON.stringify(response.body)).not.toContain('/Users/');
    });
  });
});
