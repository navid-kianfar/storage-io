import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminHttpClient } from '../../src/providers/iam/admin-http.client';
import { CephIamDriver } from '../../src/providers/iam/ceph-iam.driver';
import type { IamSubDriver, ServerConnection } from '../../src/providers/provider-driver';
import { fixtureConnection, startAdminFixture, type AdminFixture } from './admin-fixture';

/**
 * The Ceph RGW Admin Ops driver, against a recorded fixture.
 *
 * There is no Ceph container in `docker/docker-compose.dev.yml`, so what can be
 * proved here is what storage-io *sends* and how it maps what comes back — the
 * request line, the SigV4 signature, and the user and key shapes. What it cannot
 * prove is that a real RGW answers these paths; the driver's header comment says so,
 * and the bodies below are the documented Admin Ops shapes.
 */

const RGW_USER = {
  user_id: 'analytics',
  display_name: 'analytics',
  suspended: 0,
  keys: [
    { user: 'analytics', access_key: 'CEPHKEY0001', secret_key: 'never-returned-to-a-client' },
    { user: 'analytics', access_key: 'CEPHKEY0002', secret_key: 'also-not' },
  ],
};

describe('CephIamDriver', () => {
  let fixture: AdminFixture;
  let http: AdminHttpClient;
  let driver: CephIamDriver;
  let connection: ServerConnection;

  beforeEach(async () => {
    fixture = await startAdminFixture();
    http = new AdminHttpClient();
    driver = new CephIamDriver(http);
    connection = fixtureConnection(fixture.baseUrl);
  });

  afterEach(async () => {
    http.evictAll();
    await fixture.close();
  });

  const lastRequest = () => {
    const request = fixture.requests[fixture.requests.length - 1];
    if (request === undefined) throw new Error('No request reached the fixture.');
    return request;
  };

  it('signs every admin request with SigV4 over the s3 service', async () => {
    fixture.reply({ json: ['analytics'] });
    fixture.reply({ json: RGW_USER });

    await driver.users.list(connection);

    const authorization = fixture.requests[0]?.headers['authorization'] ?? '';
    expect(authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(authorization).toContain('Credential=fixture-access-key/');
    expect(authorization).toContain('/us-east-1/s3/aws4_request');
    // A real body hash, not UNSIGNED-PAYLOAD — RGW verifies it.
    expect(fixture.requests[0]?.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lists users from the metadata index and one lookup each', async () => {
    fixture.reply({ json: ['analytics'] });
    fixture.reply({ json: RGW_USER });

    const users = await driver.users.list(connection);

    expect(fixture.requests[0]?.url).toBe('/admin/metadata/user');
    expect(fixture.requests[1]?.url).toBe('/admin/user?uid=analytics');
    expect(users).toEqual([
      {
        name: 'analytics',
        status: 'enabled',
        policies: [],
        memberOf: [],
        createdAt: null,
      },
    ]);
  });

  it("maps RGW's suspended flag to a disabled user", async () => {
    fixture.reply({ json: { ...RGW_USER, suspended: 1 } });

    const user = await driver.users.get(connection, 'analytics');

    expect(user?.status).toBe('disabled');
  });

  it('answers null for a user RGW says does not exist', async () => {
    fixture.reply({ status: 404, json: { Code: 'NoSuchUser' } });

    expect(await driver.users.get(connection, 'ghost')).toBeNull();
  });

  it('creates a user with a display name, because RGW requires one', async () => {
    fixture.reply({ json: RGW_USER });

    await driver.users.create(connection, { name: 'analytics', secret: null });

    const request = lastRequest();
    expect(request.method).toBe('PUT');
    expect(request.url).toBe('/admin/user?uid=analytics&display-name=analytics');
  });

  it('suspends and resumes a user through the modify call', async () => {
    fixture.reply({ json: {} });
    await driver.users.setStatus?.(connection, 'analytics', 'disabled');
    expect(lastRequest().url).toBe('/admin/user?uid=analytics&suspended=True');

    fixture.reply({ json: {} });
    await driver.users.setStatus?.(connection, 'analytics', 'enabled');
    expect(lastRequest().url).toBe('/admin/user?uid=analytics&suspended=False');
  });

  it("lists a user's keys and reports them enabled while the user is not suspended", async () => {
    fixture.reply({ json: RGW_USER });

    const keys = await driver.keys.list(connection, 'analytics');

    expect(keys.map((key) => key.accessKeyId)).toEqual(['CEPHKEY0001', 'CEPHKEY0002']);
    expect(keys[0]).toMatchObject({ userName: 'analytics', enabled: true, expiresAt: null });
  });

  it('reports a suspended user’s keys as disabled, which is what RGW enforces', async () => {
    fixture.reply({ json: { ...RGW_USER, suspended: 1 } });

    const keys = await driver.keys.list(connection, 'analytics');

    expect(keys.every((key) => !key.enabled)).toBe(true);
  });

  it('creates a key through the ?key sub-resource and returns the newest one', async () => {
    fixture.reply({
      json: [
        { user: 'analytics', access_key: 'CEPHKEY0001', secret_key: 'old' },
        { user: 'analytics', access_key: 'CEPHKEY0003', secret_key: 'brand-new-secret' },
      ],
    });

    const created = await driver.keys.create(connection, {
      userName: 'analytics',
      name: 'ignored by rgw',
      description: null,
      expiresAt: '2030-01-01T00:00:00.000Z',
      policy: null,
    });

    const request = lastRequest();
    expect(request.method).toBe('PUT');
    // `key` is a bare flag, not `key=` — RGW routes on the sub-resource.
    expect(request.url).toBe(
      '/admin/user?key&uid=analytics&key-type=s3&generate-key=True',
    );
    expect(created).toEqual({
      accessKeyId: 'CEPHKEY0003',
      secretAccessKey: 'brand-new-secret',
      // RGW stores no expiry, so the date the caller asked for is the app's to keep.
      expiresAt: null,
    });
  });

  it('deletes a key by access key id', async () => {
    fixture.reply({ status: 200, json: {} });

    await driver.keys.delete(connection, 'CEPHKEY0001', 'analytics');

    const request = lastRequest();
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('/admin/user?key&uid=analytics&access-key=CEPHKEY0001');
  });

  it('treats deleting a key that is already gone as done', async () => {
    fixture.reply({ status: 404, json: { Code: 'InvalidAccessKeyId' } });

    await expect(driver.keys.delete(connection, 'CEPHKEY0009', 'analytics')).resolves.toBeUndefined();
  });

  it('offers no group or policy surface, so the registry can refuse once', () => {
    // RGW has neither. An absent group says so in the one place every caller checks.
    // Read through the interface every caller uses, which is where the absence
    // has to be visible.
    const asSubDriver: IamSubDriver = driver;
    expect(asSubDriver.groups).toBeUndefined();
    expect(asSubDriver.policies).toBeUndefined();
    // And a key cannot be deactivated, only removed.
    expect('update' in driver.keys).toBe(false);
  });

  it("keeps RGW's error body out of the message a client would see", async () => {
    fixture.reply({
      status: 403,
      text: '{"Code":"AccessDenied","RequestId":"tx00001","HostId":"rgw-internal-1"}',
    });

    await expect(driver.users.list(connection)).rejects.toMatchObject({
      message: 'Admin API error: AccessDenied.',
    });
  });
});
