import { S3Client, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyExpiryService } from '../../src/modules/iam-core/key-expiry.service';
import { KeyMetaRepository } from '../../src/modules/iam-core/key-meta.repository';
import { createTestApp, type TestHarness } from '../support/test-app';
import { IT_ENABLED, MINIO, SEAWEEDFS, assertContainersUp } from './containers';
import { restoreIdentities, snapshotIdentities } from './seaweed-identities';

/**
 * IAM against the real MinIO and SeaweedFS containers.
 *
 * The e2e suite proves the shapes, the validation and the failure paths. These prove
 * the things only a real server can:
 *
 * - that the admin payloads this code writes are the ones MinIO accepts — the madmin
 *   envelopes, the `?key` flags, the attach/detach endpoints;
 * - that **a secret handed back by `POST …/access-keys` actually authenticates**,
 *   which is the one claim a mock can never make good on;
 * - that a session policy really narrows the key below its user;
 * - that a rotation's grace period is finished by the sweep;
 * - and that SeaweedFS's missing half comes back as `NOT_SUPPORTED` rather than a
 *   provider error, because that is what the UI shows as "Not supported".
 */

const MINIO_SERVER = 'it-iam-minio';
const SEAWEED_SERVER = 'it-iam-seaweedfs';

/** Prefixed so a failed run leaves obvious debris rather than mystery rows. */
const USER = 'sio-it-alice';
const SECOND_USER = 'sio-it-bob';
const GROUP = 'sio-it-analysts';
const POLICY = 'sio-it-reports-read';
const SEAWEED_USER = 'sio-it-seaweed-user';

const BUCKET = 'sio-dev-bucket';

const READ_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'ReadBucket',
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:ListBucket'],
      Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
    },
  ],
};

/** Narrower than READ_POLICY on purpose: a session policy has to actually bite. */
const SESSION_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${BUCKET}/allowed/*`],
    },
  ],
};

describe.skipIf(!IT_ENABLED)('iam against live containers', () => {
  let harness: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    await assertContainersUp();
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();
  });

  afterAll(async () => {
    await harness.close();
  });

  function auth(): Record<string, string> {
    return { Cookie: cookie, Origin: harness.origin };
  }

  /* ------------------------------ MinIO ---------------------------- */

  describe('MinIO', () => {
    beforeAll(async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send({
          name: MINIO_SERVER,
          provider: MINIO.provider,
          endpoint: MINIO.endpoint,
          region: MINIO.region,
          accessKeyId: MINIO.accessKeyId,
          secretAccessKey: MINIO.secretAccessKey,
          options: { pathStyle: true, healthIntervalSec: 3600 },
        })
        .expect(201);

      await removeMinioLeftovers();
    });

    afterAll(async () => {
      await removeMinioLeftovers();
    });

    /** Every test below is order-dependent within this block, by design: the user
     * created first is the one the keys, groups and policies hang off, and
     * re-creating it per test would triple the round trips for no extra coverage. */
    it('creates a user with its first access key', async () => {
      const response = await harness
        .http()
        .post(`/api/v1/servers/${MINIO_SERVER}/iam/users`)
        .set(auth())
        .send({
          name: USER,
          secret: 'sio-it-alice-secret-1234',
          policies: [],
          groups: [],
          createAccessKey: true,
        })
        .expect(201);

      expect(response.body.user).toMatchObject({
        name: USER,
        status: 'enabled',
        serverName: MINIO_SERVER,
        provider: 'minio',
      });
      expect(response.body.accessKey).toMatchObject({
        secretAccessKey: expect.any(String),
        endpoint: MINIO.endpoint,
        region: MINIO.region,
        accessKey: { userName: USER, status: 'active' },
      });
    });

    it('lists the user in the aggregated list, with no server reported unavailable', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/iam/users?serverId=${MINIO_SERVER}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.unavailable).toEqual([]);
      const names = response.body.items.map((user: { name: string }) => user.name);
      expect(names).toContain(USER);
    });

    it('finds the user by name, with its keys attached', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${MINIO_SERVER}/iam/users/${USER}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.accessKeys).toHaveLength(1);
      expect(response.body.accessKeys[0]).toMatchObject({ userName: USER, status: 'active' });
      expect(response.body.inheritedPolicies).toEqual([]);
    });

    it('disables and re-enables the user', async () => {
      const disabled = await harness
        .http()
        .patch(`/api/v1/servers/${MINIO_SERVER}/iam/users/${USER}`)
        .set(auth())
        .send({ status: 'disabled' })
        .expect(200);
      expect(disabled.body.status).toBe('disabled');

      const enabled = await harness
        .http()
        .patch(`/api/v1/servers/${MINIO_SERVER}/iam/users/${USER}`)
        .set(auth())
        .send({ status: 'enabled' })
        .expect(200);
      expect(enabled.body.status).toBe('enabled');
    });

    /**
     * The opaque ids the web app navigates by, against a driver that really
     * lists. The e2e suite proves the 404 and the route order; only a live
     * listing proves that the id a list hands out is the id the resolve
     * endpoint answers to, and that it does not change on the next keystroke.
     */
    it('gives a listed user a stable id that resolves back to the user', async () => {
      const first = await harness
        .http()
        .get(`/api/v1/iam/users?serverId=${MINIO_SERVER}`)
        .set('Cookie', cookie)
        .expect(200);
      const second = await harness
        .http()
        .get(`/api/v1/iam/users?serverId=${MINIO_SERVER}`)
        .set('Cookie', cookie)
        .expect(200);

      const find = (body: { items: { name: string; id: string }[] }): string | undefined =>
        body.items.find((user) => user.name === USER)?.id;

      const id = find(first.body);
      expect(id).toEqual(expect.any(String));
      expect(find(second.body)).toBe(id);
      // Never the name: the id is what a URL may carry.
      expect(id).not.toBe(USER);

      const resolved = await harness
        .http()
        .get(`/api/v1/iam/users/${id as string}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(resolved.body).toMatchObject({ id, name: USER, serverName: MINIO_SERVER });
      expect(resolved.body.accessKeys).toEqual(expect.any(Array));
    });

    it('gives a listed access key an id that resolves back to the key', async () => {
      const listed = await harness
        .http()
        .get(`/api/v1/iam/access-keys?serverId=${MINIO_SERVER}&userName=${USER}`)
        .set('Cookie', cookie)
        .expect(200);

      const [key] = listed.body.items as { id: string; accessKeyId: string }[];
      expect(key?.id).toEqual(expect.any(String));

      const resolved = await harness
        .http()
        .get(`/api/v1/iam/access-keys/${key?.id as string}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(resolved.body).toMatchObject({ id: key?.id, accessKeyId: key?.accessKeyId });
    });

    it('gives a listed policy an id that resolves to its document', async () => {
      const listed = await harness
        .http()
        .get(`/api/v1/iam/policies?serverId=${MINIO_SERVER}`)
        .set('Cookie', cookie)
        .expect(200);

      const readonly = (listed.body.items as { id: string; name: string }[]).find(
        (policy) => policy.name === 'readonly',
      );
      expect(readonly?.id).toEqual(expect.any(String));

      const resolved = await harness
        .http()
        .get(`/api/v1/iam/policies/${readonly?.id as string}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(resolved.body).toMatchObject({ id: readonly?.id, name: 'readonly', builtIn: true });
      expect(resolved.body.document).toEqual(expect.any(Object));
    });

    it('never leaks MINIO_ROOT_PASSWORD through an IAM response', async () => {
      // The admin `info` payload contains it; nothing here reads that payload, and
      // this is the assertion that keeps it that way.
      const response = await harness
        .http()
        .get(`/api/v1/iam/users?serverId=${MINIO_SERVER}`)
        .set('Cookie', cookie)
        .expect(200);

      const body = JSON.stringify(response.body);
      expect(body).not.toContain(MINIO.secretAccessKey);
      expect(body).not.toContain('MINIO_ROOT_PASSWORD');
    });

    describe('canned policies', () => {
      it('lists MinIO built-ins and marks them read-only', async () => {
        const response = await harness
          .http()
          .get(`/api/v1/iam/policies?serverId=${MINIO_SERVER}`)
          .set('Cookie', cookie)
          .expect(200);

        const byName = new Map<string, { builtIn: boolean }>(
          response.body.items.map((policy: { name: string; builtIn: boolean }) => [
            policy.name,
            policy,
          ]),
        );
        expect(byName.get('readwrite')?.builtIn).toBe(true);
        expect(byName.get('consoleAdmin')?.builtIn).toBe(true);
      });

      it('refuses to change a built-in policy', async () => {
        const response = await harness
          .http()
          .put(`/api/v1/servers/${MINIO_SERVER}/iam/policies/readwrite`)
          .set(auth())
          .send({ document: READ_POLICY })
          .expect(409);

        expect(response.body.code).toBe('CONFLICT');
      });

      it('refuses to delete a built-in policy', async () => {
        await harness
          .http()
          .delete(`/api/v1/servers/${MINIO_SERVER}/iam/policies/readonly`)
          .set(auth())
          .expect(409);
      });

      it('creates a policy and reads its document back', async () => {
        await harness
          .http()
          .put(`/api/v1/servers/${MINIO_SERVER}/iam/policies/${POLICY}`)
          .set(auth())
          .send({ document: READ_POLICY, description: 'Read the reports bucket' })
          .expect(200);

        const response = await harness
          .http()
          .get(`/api/v1/servers/${MINIO_SERVER}/iam/policies/${POLICY}`)
          .set('Cookie', cookie)
          .expect(200);

        expect(response.body.builtIn).toBe(false);
        expectSamePolicy(response.body.document, READ_POLICY);
        // MinIO stores no description for a canned policy; storage-io does.
        expect(response.body.description).toBe('Read the reports bucket');
        expect(response.body.updatedAt).toEqual(expect.any(String));
      });

      it('attaches the policy to the user and shows it on both sides', async () => {
        const updated = await harness
          .http()
          .put(`/api/v1/servers/${MINIO_SERVER}/iam/users/${USER}/policies`)
          .set(auth())
          .send({ policies: [POLICY] })
          .expect(200);

        expect(updated.body.policies).toEqual([POLICY]);

        const policy = await harness
          .http()
          .get(`/api/v1/servers/${MINIO_SERVER}/iam/policies/${POLICY}`)
          .set('Cookie', cookie)
          .expect(200);

        expect(policy.body.attachedTo.users).toContain(USER);
        expect(policy.body.attachedCount).toBeGreaterThanOrEqual(1);
      });

      it('refuses to delete a policy that is still attached', async () => {
        const response = await harness
          .http()
          .delete(`/api/v1/servers/${MINIO_SERVER}/iam/policies/${POLICY}`)
          .set(auth())
          .expect(409);

        expect(response.body.detail).toContain('detach');
      });

      it('detaches the policy by writing an empty set', async () => {
        const updated = await harness
          .http()
          .put(`/api/v1/servers/${MINIO_SERVER}/iam/users/${USER}/policies`)
          .set(auth())
          .send({ policies: [] })
          .expect(200);

        expect(updated.body.policies).toEqual([]);
      });

      it('records a version per edit and restores an earlier document', async () => {
        const edited = {
          ...READ_POLICY,
          Statement: [{ ...READ_POLICY.Statement[0], Action: ['s3:GetObject'] }],
        };

        await harness
          .http()
          .put(`/api/v1/servers/${MINIO_SERVER}/iam/policies/${POLICY}`)
          .set(auth())
          .send({ document: edited, description: 'Narrowed to reads' })
          .expect(200);

        const versions = await harness
          .http()
          .get(`/api/v1/servers/${MINIO_SERVER}/iam/policies/${POLICY}/versions`)
          .set('Cookie', cookie)
          .expect(200);

        // Newest first: the narrowed document, then the original.
        expect(versions.body.items.length).toBeGreaterThanOrEqual(2);
        // The snapshot is storage-io's own row, so it is byte-for-byte what was sent.
        expect(versions.body.items[0].document).toEqual(edited);

        const original = versions.body.items.find(
          (version: { document: unknown }) =>
            JSON.stringify(version.document) === JSON.stringify(READ_POLICY),
        );
        expect(original).toBeDefined();

        const restored = await harness
          .http()
          .post(
            `/api/v1/servers/${MINIO_SERVER}/iam/policies/${POLICY}/versions/${original.id}/restore`,
          )
          .set(auth())
          .expect(201);

        expectSamePolicy(restored.body.document, READ_POLICY);

        // And the server really has it, not just the response.
        const reread = await harness
          .http()
          .get(`/api/v1/servers/${MINIO_SERVER}/iam/policies/${POLICY}`)
          .set('Cookie', cookie)
          .expect(200);
        expectSamePolicy(reread.body.document, READ_POLICY);
      });
    });

    describe('groups', () => {
      beforeAll(async () => {
        await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/users`)
          .set(auth())
          .send({
            name: SECOND_USER,
            secret: 'sio-it-bob-secret-1234',
            policies: [],
            groups: [],
            createAccessKey: false,
          })
          .expect(201);
      });

      it('creates a group with a member and a policy', async () => {
        const response = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/groups`)
          .set(auth())
          .send({ name: GROUP, members: [USER], policies: [POLICY] })
          .expect(201);

        expect(response.body).toMatchObject({
          name: GROUP,
          members: [USER],
          policies: [POLICY],
          status: 'enabled',
        });
      });

      it('refuses a second group with the same name', async () => {
        const response = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/groups`)
          .set(auth())
          .send({ name: GROUP, members: [USER], policies: [] })
          .expect(409);

        expect(response.body.code).toBe('CONFLICT');
      });

      it('reconciles membership to exactly the set given', async () => {
        const response = await harness
          .http()
          .patch(`/api/v1/servers/${MINIO_SERVER}/iam/groups/${GROUP}`)
          .set(auth())
          .send({ name: GROUP, members: [SECOND_USER], policies: [POLICY] })
          .expect(200);

        // A full-set PUT means the first user is out, not merely "not added".
        expect(response.body.members).toEqual([SECOND_USER]);
      });

      it('shows a group policy as inherited on the member', async () => {
        const response = await harness
          .http()
          .get(`/api/v1/servers/${MINIO_SERVER}/iam/users/${SECOND_USER}`)
          .set('Cookie', cookie)
          .expect(200);

        expect(response.body.groups).toContain(GROUP);
        expect(response.body.inheritedPolicies).toEqual([{ policy: POLICY, fromGroup: GROUP }]);
      });

      it('disables the group', async () => {
        const response = await harness
          .http()
          .patch(`/api/v1/servers/${MINIO_SERVER}/iam/groups/${GROUP}`)
          .set(auth())
          .send({ name: GROUP, members: [SECOND_USER], policies: [POLICY], status: 'disabled' })
          .expect(200);

        expect(response.body.status).toBe('disabled');
      });

      it("replaces a user's group membership from the user side", async () => {
        const response = await harness
          .http()
          .put(`/api/v1/servers/${MINIO_SERVER}/iam/users/${USER}/groups`)
          .set(auth())
          .send({ groups: [GROUP] })
          .expect(200);

        expect(response.body.groups).toEqual([GROUP]);

        const cleared = await harness
          .http()
          .put(`/api/v1/servers/${MINIO_SERVER}/iam/users/${USER}/groups`)
          .set(auth())
          .send({ groups: [] })
          .expect(200);
        expect(cleared.body.groups).toEqual([]);
      });

      it('deletes the group, detaching its policy first', async () => {
        await harness
          .http()
          .delete(`/api/v1/servers/${MINIO_SERVER}/iam/groups/${GROUP}`)
          .set(auth())
          .expect(204);

        const response = await harness
          .http()
          .get(`/api/v1/iam/groups?serverId=${MINIO_SERVER}`)
          .set('Cookie', cookie)
          .expect(200);

        const names = response.body.items.map((group: { name: string }) => group.name);
        expect(names).not.toContain(GROUP);
      });
    });

    describe('access keys', () => {
      it("the created secret authenticates against MinIO's S3 API", async () => {
        // A MinIO service account inherits its parent user's permissions, so the
        // user needs one: without it MinIO answers AccessDenied, correctly.
        await harness
          .http()
          .put(`/api/v1/servers/${MINIO_SERVER}/iam/users/${USER}/policies`)
          .set(auth())
          .send({ policies: ['readwrite'] })
          .expect(200);

        const created = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys`)
          .set(auth())
          .send({ userName: USER, name: 'works-for-s3', expiresAt: null, policy: null })
          .expect(201);

        const client = s3ClientFor(
          created.body.accessKey.accessKeyId,
          created.body.secretAccessKey,
        );
        try {
          // The one claim no mock can make good on: the credential works.
          const listed = await client.send(
            new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1 }),
          );
          expect(listed.$metadata.httpStatusCode).toBe(200);
        } finally {
          client.destroy();
        }

        await harness
          .http()
          .delete(
            `/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${created.body.accessKey.accessKeyId}`,
          )
          .set(auth())
          .expect(204);
      });

      it('a session policy really narrows the key below its user', async () => {
        // The parent user still has `readwrite` from the test above, so a refused
        // write can only be the session policy doing its job.
        const created = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys`)
          .set(auth())
          .send({
            userName: USER,
            name: 'scoped',
            expiresAt: null,
            policy: SESSION_POLICY,
          })
          .expect(201);

        expect(created.body.accessKey.restricted).toBe(true);

        const client = s3ClientFor(
          created.body.accessKey.accessKeyId,
          created.body.secretAccessKey,
        );
        try {
          // The session policy allows only GetObject under allowed/, so a write is
          // refused even though the parent user is not restricted that way.
          await expect(
            client.send(
              new PutObjectCommand({ Bucket: BUCKET, Key: 'denied/nope.txt', Body: 'no' }),
            ),
          ).rejects.toMatchObject({ name: expect.stringMatching(/AccessDenied/) });
        } finally {
          client.destroy();
        }

        await harness
          .http()
          .delete(
            `/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${created.body.accessKey.accessKeyId}`,
          )
          .set(auth())
          .expect(204);
      });

      it('stores an expiry MinIO enforces itself, and lists it as expiring', async () => {
        const expiresAt = new Date(Date.now() + 3 * 86_400_000).toISOString();

        const created = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys`)
          .set(auth())
          .send({ userName: USER, name: 'expires-soon', expiresAt, policy: null })
          .expect(201);

        expect(created.body.accessKey.expiresAt).toEqual(expect.any(String));

        const expiring = await harness
          .http()
          .get(`/api/v1/iam/access-keys?serverId=${MINIO_SERVER}&status=expiring`)
          .set('Cookie', cookie)
          .expect(200);

        const ids = expiring.body.items.map((key: { accessKeyId: string }) => key.accessKeyId);
        expect(ids).toContain(created.body.accessKey.accessKeyId);
        expect(expiring.body.counts.expiring).toBeGreaterThanOrEqual(1);

        await harness
          .http()
          .delete(
            `/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${created.body.accessKey.accessKeyId}`,
          )
          .set(auth())
          .expect(204);
      });

      it('refuses an expiry in the past', async () => {
        const response = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys`)
          .set(auth())
          .send({
            userName: USER,
            name: 'already-gone',
            expiresAt: '2020-01-01T00:00:00.000Z',
            policy: null,
          })
          .expect(400);

        expect(response.body.code).toBe('VALIDATION');
      });

      it('renames and disables a key', async () => {
        const created = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys`)
          .set(auth())
          .send({ userName: USER, name: 'before', expiresAt: null, policy: null })
          .expect(201);
        const id = created.body.accessKey.accessKeyId;

        const renamed = await harness
          .http()
          .patch(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${id}`)
          .set(auth())
          .send({ name: 'after' })
          .expect(200);
        expect(renamed.body.name).toBe('after');

        const disabled = await harness
          .http()
          .patch(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${id}`)
          .set(auth())
          .send({ status: 'disabled' })
          .expect(200);
        expect(disabled.body.status).toBe('disabled');

        await harness
          .http()
          .delete(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${id}`)
          .set(auth())
          .expect(204);
      });

      it('rotates with no grace period, disabling the old key at once', async () => {
        const created = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys`)
          .set(auth())
          .send({ userName: USER, name: 'rotate-now', expiresAt: null, policy: null })
          .expect(201);
        const oldId = created.body.accessKey.accessKeyId;

        const rotated = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${oldId}/rotate`)
          .set(auth())
          .send({ graceSeconds: 0, expiresAt: null })
          .expect(201);

        expect(rotated.body.accessKey.accessKeyId).not.toBe(oldId);
        expect(rotated.body.secretAccessKey).toEqual(expect.any(String));
        expect(rotated.body.accessKey.name).toContain('rotated');

        const keys = await harness
          .http()
          .get(`/api/v1/iam/access-keys?serverId=${MINIO_SERVER}&userName=${USER}`)
          .set('Cookie', cookie)
          .expect(200);

        const oldKey = keys.body.items.find(
          (key: { accessKeyId: string }) => key.accessKeyId === oldId,
        );
        expect(oldKey.status).toBe('disabled');

        await harness
          .http()
          .delete(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${oldId}`)
          .set(auth())
          .expect(204);
        await harness
          .http()
          .delete(
            `/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${rotated.body.accessKey.accessKeyId}`,
          )
          .set(auth())
          .expect(204);
      });

      it('rotates with a grace period, and the sweep finishes it', async () => {
        const created = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys`)
          .set(auth())
          .send({ userName: USER, name: 'rotate-later', expiresAt: null, policy: null })
          .expect(201);
        const oldId = created.body.accessKey.accessKeyId;

        const rotated = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${oldId}/rotate`)
          .set(auth())
          .send({ graceSeconds: 3600, expiresAt: null })
          .expect(201);
        const newId = rotated.body.accessKey.accessKeyId;

        // Still usable: that is the point of the grace period.
        const during = await harness
          .http()
          .get(`/api/v1/iam/access-keys?serverId=${MINIO_SERVER}&userName=${USER}`)
          .set('Cookie', cookie)
          .expect(200);
        const beforeSweep = during.body.items.find(
          (key: { accessKeyId: string }) => key.accessKeyId === oldId,
        );
        expect(beforeSweep.status).toBe('active');
        expect(beforeSweep.rotation).toMatchObject({ replacedBy: newId });

        // A second rotation while one is in flight is a mistake worth refusing.
        await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${oldId}/rotate`)
          .set(auth())
          .send({ graceSeconds: 0, expiresAt: null })
          .expect(409);

        // Drive the sweep at a moment past the grace period rather than waiting an
        // hour for the cron.
        const sweep = harness.app.get(KeyExpiryService);
        await sweep.run(new Date(Date.now() + 2 * 3600_000));

        const after = await harness
          .http()
          .get(`/api/v1/iam/access-keys?serverId=${MINIO_SERVER}&userName=${USER}`)
          .set('Cookie', cookie)
          .expect(200);
        const afterSweep = after.body.items.find(
          (key: { accessKeyId: string }) => key.accessKeyId === oldId,
        );
        expect(afterSweep.status).toBe('disabled');
        expect(afterSweep.rotation).toBeNull();

        await harness
          .http()
          .delete(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${oldId}`)
          .set(auth())
          .expect(204);
        await harness
          .http()
          .delete(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${newId}`)
          .set(auth())
          .expect(204);
      });

      it('the sweep expires an app-tracked key and stops reporting it as usable', async () => {
        const created = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys`)
          .set(auth())
          .send({ userName: USER, name: 'to-expire', expiresAt: null, policy: null })
          .expect(201);
        const id = created.body.accessKey.accessKeyId;

        // Backdate the tracked expiry, which is the state an IAM or Garage key
        // reaches on its own — MinIO would have refused the date at creation.
        const server = await harness
          .http()
          .get(`/api/v1/servers/${MINIO_SERVER}`)
          .set('Cookie', cookie)
          .expect(200);
        const keyMeta = harness.app.get(KeyMetaRepository);
        keyMeta.upsert(server.body.id, id, {
          userName: USER,
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
        });

        const sweep = harness.app.get(KeyExpiryService);
        await sweep.run();

        const after = await harness
          .http()
          .get(`/api/v1/iam/access-keys?serverId=${MINIO_SERVER}&userName=${USER}`)
          .set('Cookie', cookie)
          .expect(200);
        const expired = after.body.items.find(
          (key: { accessKeyId: string }) => key.accessKeyId === id,
        );
        expect(expired.status).toBe('expired');

        // And it raised a notification rather than letting a key die silently.
        const notifications = await harness
          .http()
          .get('/api/v1/notifications')
          .set('Cookie', cookie)
          .expect(200);
        const titles = notifications.body.items.map((item: { title: string }) => item.title);
        expect(titles).toContain('An access key expired');

        await harness
          .http()
          .delete(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${id}`)
          .set(auth())
          .expect(204);
      });

      it('exports the key list as CSV with the real rows in it', async () => {
        const created = await harness
          .http()
          .post(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys`)
          .set(auth())
          .send({ userName: USER, name: 'csv-row', expiresAt: null, policy: null })
          .expect(201);

        const response = await harness
          .http()
          .get(`/api/v1/iam/access-keys/export.csv?serverId=${MINIO_SERVER}`)
          .set('Cookie', cookie)
          .expect(200);

        expect(response.text).toContain(created.body.accessKey.accessKeyId);
        expect(response.text).toContain('csv-row');
        // A secret must never reach an export.
        expect(response.text).not.toContain(created.body.secretAccessKey);

        await harness
          .http()
          .delete(
            `/api/v1/servers/${MINIO_SERVER}/iam/access-keys/${created.body.accessKey.accessKeyId}`,
          )
          .set(auth())
          .expect(204);
      });

      it('answers NOT_FOUND for a key that does not exist', async () => {
        const response = await harness
          .http()
          .patch(`/api/v1/servers/${MINIO_SERVER}/iam/access-keys/NOSUCHKEY0000000001`)
          .set(auth())
          .send({ status: 'disabled' })
          .expect(404);

        expect(response.body.code).toBe('NOT_FOUND');
      });
    });

    it('counts users and keys for the dashboard, and writes the per-server count', async () => {
      const { IamStatsService } = await import('../../src/modules/iam-core/iam-stats.service');
      const stats = harness.app.get(IamStatsService);

      const counts = await stats.refresh();

      expect(counts.users).toBeGreaterThanOrEqual(2);
      expect(counts.at).toEqual(expect.any(String));

      const server = await harness
        .http()
        .get(`/api/v1/servers/${MINIO_SERVER}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(server.body.counts.users).toBeGreaterThanOrEqual(2);
    });

    describe('credential rotation', () => {
      /**
       * A rotation on its own server, so a failure cannot take the servers the rest
       * of the suite uses with it. The stored key here is MinIO's root key, which is
       * the realistic case and the one with the interesting edge: root cannot be
       * disabled, so the rotation has to leave it and say so.
       */
      const ROTATE_SERVER = 'it-iam-rotate';

      beforeAll(async () => {
        await harness
          .http()
          .post('/api/v1/servers')
          .set(auth())
          .send({
            name: ROTATE_SERVER,
            provider: MINIO.provider,
            endpoint: MINIO.endpoint,
            region: MINIO.region,
            accessKeyId: MINIO.accessKeyId,
            secretAccessKey: MINIO.secretAccessKey,
            options: { pathStyle: true, healthIntervalSec: 3600 },
          })
          .expect(201);
      });

      afterAll(async () => {
        // Whatever the rotation left the row pointing at, the service account it
        // created has to go, or the container accumulates one per run.
        const keys = await harness
          .http()
          .get(`/api/v1/iam/access-keys?serverId=${ROTATE_SERVER}&userName=${MINIO.accessKeyId}`)
          .set('Cookie', cookie);
        for (const key of keys.body.items ?? []) {
          await harness
            .http()
            .delete(`/api/v1/servers/${ROTATE_SERVER}/iam/access-keys/${key.accessKeyId}`)
            .set(auth());
        }
        await harness.http().delete(`/api/v1/servers/${ROTATE_SERVER}`).set(auth());
      });

      it('creates a working replacement, swaps it in and keeps admin access', async () => {
        const before = await harness
          .http()
          .get(`/api/v1/servers/${ROTATE_SERVER}`)
          .set('Cookie', cookie)
          .expect(200);
        expect(before.body.accessKeyId).toBe(MINIO.accessKeyId);

        const response = await harness
          .http()
          .post(`/api/v1/servers/${ROTATE_SERVER}/rotate-credentials`)
          .set(auth())
          .send({ mode: 'auto' })
          .expect(201);

        expect(response.body.rotatedAt).toEqual(expect.any(String));
        expect(response.body.server.accessKeyId).not.toBe(MINIO.accessKeyId);
        // The secret is never returned, only its mask.
        expect(JSON.stringify(response.body)).not.toContain(MINIO.secretAccessKey);
        expect(response.body.server.secretMasked).toMatch(/^••••/);

        // And the new credential really works, for S3 *and* for the admin API — the
        // second is the one a rotation can silently lose.
        const test = await harness
          .http()
          .post(`/api/v1/servers/${ROTATE_SERVER}/test`)
          .set(auth())
          .expect(201);
        const byId = new Map(
          test.body.checks.map((check: { id: string; status: string }) => [check.id, check]),
        );
        expect(byId.get('auth')).toMatchObject({ status: 'ok' });
        expect(byId.get('admin')).toMatchObject({ status: 'ok' });

        // Users still list, which is what "kept admin rights" means in practice.
        const users = await harness
          .http()
          .get(`/api/v1/iam/users?serverId=${ROTATE_SERVER}`)
          .set('Cookie', cookie)
          .expect(200);
        expect(users.body.unavailable).toEqual([]);
      });

      it('warns that the previous key was left active, because root cannot be disabled', async () => {
        const notifications = await harness
          .http()
          .get('/api/v1/notifications')
          .set('Cookie', cookie)
          .expect(200);

        const titles = notifications.body.items.map((item: { title: string }) => item.title);
        expect(titles).toContain('A rotated credential was left active');

        const warning = notifications.body.items.find(
          (item: { title: string }) => item.title === 'A rotated credential was left active',
        );
        // The old key id is masked, not spelled out.
        expect(warning.detail).not.toContain(MINIO.accessKeyId);
        expect(warning.detail).toContain('••••');
      });

      it('rotates again from the service account it now uses, and retires that one', async () => {
        const before = await harness
          .http()
          .get(`/api/v1/servers/${ROTATE_SERVER}`)
          .set('Cookie', cookie)
          .expect(200);
        const previous = before.body.accessKeyId;

        await harness
          .http()
          .post(`/api/v1/servers/${ROTATE_SERVER}/rotate-credentials`)
          .set(auth())
          .send({ mode: 'auto' })
          .expect(201);

        // This time the replaced key *is* a service account, so it is disabled.
        const keys = await harness
          .http()
          .get(`/api/v1/iam/access-keys?serverId=${ROTATE_SERVER}&userName=${MINIO.accessKeyId}`)
          .set('Cookie', cookie)
          .expect(200);
        const old = keys.body.items.find(
          (key: { accessKeyId: string }) => key.accessKeyId === previous,
        );
        expect(old?.status).toBe('disabled');
      });

      it('lists the root-owned service accounts the rotation created', async () => {
        // `list-users` does not include the root user, so a service account whose
        // parent is root used to be invisible here — which meant the keys the
        // rotation itself creates could not be seen or removed from the UI.
        const keys = await harness
          .http()
          .get(`/api/v1/iam/access-keys?serverId=${ROTATE_SERVER}`)
          .set('Cookie', cookie)
          .expect(200);

        const owned = keys.body.items.filter(
          (key: { userName: string }) => key.userName === MINIO.accessKeyId,
        );
        expect(owned.length).toBeGreaterThanOrEqual(1);
        expect(owned.some((key: { name: string | null }) => key.name?.includes('rotated'))).toBe(
          true,
        );
      });

      it('refuses a manual rotation whose credentials do not work, and changes nothing', async () => {
        const before = await harness
          .http()
          .get(`/api/v1/servers/${ROTATE_SERVER}`)
          .set('Cookie', cookie)
          .expect(200);

        const response = await harness
          .http()
          .post(`/api/v1/servers/${ROTATE_SERVER}/rotate-credentials`)
          .set(auth())
          .send({
            mode: 'manual',
            accessKeyId: 'NOTAREALKEY000001',
            secretAccessKey: 'nor-is-this-one',
          })
          .expect(400);

        expect(response.body.code).toBe('VALIDATION');
        expect(JSON.stringify(response.body)).not.toContain('nor-is-this-one');

        const after = await harness
          .http()
          .get(`/api/v1/servers/${ROTATE_SERVER}`)
          .set('Cookie', cookie)
          .expect(200);
        expect(after.body.accessKeyId).toBe(before.body.accessKeyId);
        expect(after.body.secretMasked).toBe(before.body.secretMasked);
      });

      it('accepts a manual rotation back to a credential that does work', async () => {
        const response = await harness
          .http()
          .post(`/api/v1/servers/${ROTATE_SERVER}/rotate-credentials`)
          .set(auth())
          .send({
            mode: 'manual',
            accessKeyId: MINIO.accessKeyId,
            secretAccessKey: MINIO.secretAccessKey,
          })
          .expect(201);

        expect(response.body.server.accessKeyId).toBe(MINIO.accessKeyId);
        expect(JSON.stringify(response.body)).not.toContain(MINIO.secretAccessKey);
      });
    });

    it('deletes a user and its keys together', async () => {
      await harness
        .http()
        .delete(`/api/v1/servers/${MINIO_SERVER}/iam/users/${SECOND_USER}`)
        .set(auth())
        .expect(204);

      await harness
        .http()
        .get(`/api/v1/servers/${MINIO_SERVER}/iam/users/${SECOND_USER}`)
        .set('Cookie', cookie)
        .expect(404);

      const keys = await harness
        .http()
        .get(`/api/v1/iam/access-keys?serverId=${MINIO_SERVER}`)
        .set('Cookie', cookie)
        .expect(200);
      const owners = keys.body.items.map((key: { userName: string }) => key.userName);
      expect(owners).not.toContain(SECOND_USER);
    });

    /**
     * Removes anything a previous run left behind, in dependency order, and then
     * *checks* that it worked.
     *
     * The order is users, then the group, then the policy: MinIO removes a user's
     * service accounts with the user, and refuses to remove a policy that is still
     * attached to either. The verification at the end matters more than it looks —
     * a run that died half way used to leave an extra key behind, and the next run
     * failed twenty tests three describes later instead of failing here.
     */
    async function removeMinioLeftovers(): Promise<void> {
      for (const name of [USER, SECOND_USER]) {
        await harness
          .http()
          .put(`/api/v1/servers/${MINIO_SERVER}/iam/users/${name}/policies`)
          .set(auth())
          .send({ policies: [] });
        await harness
          .http()
          .put(`/api/v1/servers/${MINIO_SERVER}/iam/users/${name}/groups`)
          .set(auth())
          .send({ groups: [] });
        await harness
          .http()
          .delete(`/api/v1/servers/${MINIO_SERVER}/iam/users/${name}`)
          .set(auth());
      }
      await harness
        .http()
        .delete(`/api/v1/servers/${MINIO_SERVER}/iam/groups/${GROUP}`)
        .set(auth());
      await harness
        .http()
        .delete(`/api/v1/servers/${MINIO_SERVER}/iam/policies/${POLICY}`)
        .set(auth());

      for (const name of [USER, SECOND_USER]) {
        await harness
          .http()
          .get(`/api/v1/servers/${MINIO_SERVER}/iam/users/${name}`)
          .set('Cookie', cookie)
          .expect(404);
      }
    }
  });

  /* ---------------------------- SeaweedFS -------------------------- */

  describe('SeaweedFS', () => {
    /**
     * SeaweedFS's IAM API rewrites the filer's whole identity store, so a
     * `DeleteUser` here can take the seeded `sio-dev-admin` identity with it and
     * break the documented dev credentials for everyone. The store is snapshotted
     * before this block touches IAM and restored after — see
     * `seaweed-identities.ts`.
     */
    let identitySnapshot: string | null = null;

    beforeAll(async () => {
      identitySnapshot = await snapshotIdentities();
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send({
          name: SEAWEED_SERVER,
          provider: SEAWEEDFS.provider,
          endpoint: SEAWEEDFS.endpoint,
          region: SEAWEEDFS.region,
          accessKeyId: SEAWEEDFS.accessKeyId,
          secretAccessKey: SEAWEEDFS.secretAccessKey,
          options: {
            pathStyle: true,
            healthIntervalSec: 3600,
            iamEndpoint: SEAWEEDFS.iamEndpoint,
          },
        })
        .expect(201);

      await harness
        .http()
        .delete(`/api/v1/servers/${SEAWEED_SERVER}/iam/users/${SEAWEED_USER}`)
        .set(auth());
    });

    afterAll(async () => {
      await harness
        .http()
        .delete(`/api/v1/servers/${SEAWEED_SERVER}/iam/users/${SEAWEED_USER}`)
        .set(auth());
      await restoreIdentities(identitySnapshot);
    });

    it('reports users and access keys supported, groups and policies not', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${SEAWEED_SERVER}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.capabilities).toMatchObject({
        iamUsers: 'supported',
        accessKeys: 'supported',
        // Verified against 3.97: every group call and ListPolicies answer 501.
        iamGroups: 'not_supported',
        iamPolicies: 'not_supported',
        accessKeyExpiry: 'not_supported',
      });
    });

    it('creates a user through the IAM-compatible API', async () => {
      const response = await harness
        .http()
        .post(`/api/v1/servers/${SEAWEED_SERVER}/iam/users`)
        .set(auth())
        .send({
          name: SEAWEED_USER,
          secret: null,
          policies: [],
          groups: [],
          createAccessKey: false,
        })
        .expect(201);

      expect(response.body.user).toMatchObject({
        name: SEAWEED_USER,
        serverName: SEAWEED_SERVER,
        provider: 'seaweedfs',
      });
      expect(response.body.accessKey).toBeNull();
    });

    it('lists the user, and the aggregated list spans both servers', async () => {
      const single = await harness
        .http()
        .get(`/api/v1/iam/users?serverId=${SEAWEED_SERVER}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(single.body.items.map((user: { name: string }) => user.name)).toContain(SEAWEED_USER);

      const all = await harness.http().get('/api/v1/iam/users').set('Cookie', cookie).expect(200);
      const servers = new Set(
        all.body.items.map((user: { serverName: string }) => user.serverName),
      );
      expect(servers.has(SEAWEED_SERVER)).toBe(true);
      expect(servers.has(MINIO_SERVER)).toBe(true);
      expect(all.body.unavailable).toEqual([]);
    });

    it('creates an access key whose secret works against the S3 gateway', async () => {
      const created = await harness
        .http()
        .post(`/api/v1/servers/${SEAWEED_SERVER}/iam/access-keys`)
        .set(auth())
        .send({ userName: SEAWEED_USER, name: 'seaweed key', expiresAt: null, policy: null })
        .expect(201);

      expect(created.body.accessKey).toMatchObject({
        userName: SEAWEED_USER,
        status: 'active',
        // SeaweedFS stores no name for a key; storage-io keeps it.
        name: 'seaweed key',
      });

      const client = new S3Client({
        endpoint: SEAWEEDFS.endpoint,
        region: SEAWEEDFS.region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: created.body.accessKey.accessKeyId,
          secretAccessKey: created.body.secretAccessKey,
        },
      });
      try {
        // The key exists and is usable as a credential: SeaweedFS answers rather
        // than rejecting the signature. Whether it is *authorised* for a bucket is
        // its own policy vocabulary's business, so anything but an auth failure is
        // proof enough that the credential registered.
        const outcome = await client
          .send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1 }))
          .then(() => 'ok')
          .catch((error: { name?: string }) => error.name ?? 'unknown');
        expect(outcome).not.toBe('InvalidAccessKeyId');
        expect(outcome).not.toBe('SignatureDoesNotMatch');
      } finally {
        client.destroy();
      }

      await harness
        .http()
        .delete(
          `/api/v1/servers/${SEAWEED_SERVER}/iam/access-keys/${created.body.accessKey.accessKeyId}`,
        )
        .set(auth())
        .expect(204);
    });

    it('refuses a group operation as NOT_SUPPORTED rather than as a provider error', async () => {
      const response = await harness
        .http()
        .post(`/api/v1/servers/${SEAWEED_SERVER}/iam/groups`)
        .set(auth())
        .send({ name: 'nope', members: [SEAWEED_USER], policies: [] })
        .expect(409);

      expect(response.body.code).toBe('NOT_SUPPORTED');
      // Refused from the capability profile, before any request leaves the process,
      // so the message names the provider rather than echoing a 501.
      expect(response.body.detail).toContain('seaweedfs');
      expect(response.body.detail).toContain('iamGroups');
    });

    it('refuses a policy write as NOT_SUPPORTED', async () => {
      const response = await harness
        .http()
        .put(`/api/v1/servers/${SEAWEED_SERVER}/iam/policies/nope`)
        .set(auth())
        .send({ document: READ_POLICY })
        .expect(409);

      expect(response.body.code).toBe('NOT_SUPPORTED');
    });

    it('leaves SeaweedFS out of the aggregated group and policy lists entirely', async () => {
      const groups = await harness
        .http()
        .get('/api/v1/iam/groups')
        .set('Cookie', cookie)
        .expect(200);
      const policies = await harness
        .http()
        .get('/api/v1/iam/policies')
        .set('Cookie', cookie)
        .expect(200);

      // `not_supported` is not a failure, so it belongs in neither `items` nor
      // `unavailable` — the server's capability map is where the UI reads it.
      for (const body of [groups.body, policies.body]) {
        const servers = body.items.map((item: { serverName: string }) => item.serverName);
        expect(servers).not.toContain(SEAWEED_SERVER);
        const unavailable = body.unavailable.map((entry: { serverId: string }) => entry.serverId);
        expect(unavailable).not.toContain(SEAWEED_SERVER);
      }
    });

    it('refuses to disable a SeaweedFS key, because it cannot', async () => {
      const created = await harness
        .http()
        .post(`/api/v1/servers/${SEAWEED_SERVER}/iam/access-keys`)
        .set(auth())
        .send({ userName: SEAWEED_USER, name: 'cannot-disable', expiresAt: null, policy: null })
        .expect(201);
      const id = created.body.accessKey.accessKeyId;

      const response = await harness
        .http()
        .patch(`/api/v1/servers/${SEAWEED_SERVER}/iam/access-keys/${id}`)
        .set(auth())
        .send({ status: 'disabled' })
        .expect(409);
      expect(response.body.code).toBe('NOT_SUPPORTED');

      // And rotation, which needs the same ability, is refused with a way forward.
      const rotate = await harness
        .http()
        .post(`/api/v1/servers/${SEAWEED_SERVER}/iam/access-keys/${id}/rotate`)
        .set(auth())
        .send({ graceSeconds: 0, expiresAt: null })
        .expect(409);
      expect(rotate.body.detail).toContain('create a new key');

      await harness
        .http()
        .delete(`/api/v1/servers/${SEAWEED_SERVER}/iam/access-keys/${id}`)
        .set(auth())
        .expect(204);
    });

    it('deletes the user', async () => {
      await harness
        .http()
        .delete(`/api/v1/servers/${SEAWEED_SERVER}/iam/users/${SEAWEED_USER}`)
        .set(auth())
        .expect(204);

      await harness
        .http()
        .get(`/api/v1/servers/${SEAWEED_SERVER}/iam/users/${SEAWEED_USER}`)
        .set('Cookie', cookie)
        .expect(404);
    });
  });
});

/** A client built from a credential the API just handed out. */
function s3ClientFor(accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    endpoint: MINIO.endpoint,
    region: MINIO.region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

/**
 * Compares a policy the server handed back with the one that was sent.
 *
 * MinIO normalises a canned policy rather than storing the JSON verbatim: it
 * reorders `Action` entries, because to IAM they are a set. Asserting deep equality
 * on the round trip would be asserting MinIO's internal ordering — it passed once and
 * failed on the next run — so the comparison is over the statements with their
 * string lists sorted.
 */
function expectSamePolicy(actual: unknown, expected: unknown): void {
  expect(withSortedLists(actual)).toEqual(withSortedLists(expected));
}

function withSortedLists(value: unknown): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map(withSortedLists);
    const allStrings = mapped.every((entry) => typeof entry === 'string');
    return allStrings ? [...mapped].sort() : mapped;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, withSortedLists(entry)]),
    );
  }
  return value;
}
