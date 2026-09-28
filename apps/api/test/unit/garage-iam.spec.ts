import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminHttpClient } from '../../src/providers/iam/admin-http.client';
import { GarageIamDriver } from '../../src/providers/iam/garage-iam.driver';
import type { IamSubDriver, ServerConnection } from '../../src/providers/provider-driver';
import { fixtureConnection, startAdminFixture, type AdminFixture } from './admin-fixture';

/**
 * The Garage admin driver, against a recorded fixture.
 *
 * Garage has no users: a key *is* the identity. These assert that the mapping says
 * so rather than inventing a user layer on top — a "user" and an "access key" are
 * the same object under two names, and both screens show it.
 *
 * There is no Garage container in `docker/docker-compose.dev.yml`; the paths are the
 * v1 admin API, which the driver's header comment records along with what it does
 * not speak.
 */

const KEY_LIST = [
  { id: 'GK31c2f218a2e44f485b94239e', name: 'backups' },
  { id: 'GK9ac1cc0f6c4b47a8b2d23f10', name: null },
];

describe('GarageIamDriver', () => {
  let fixture: AdminFixture;
  let http: AdminHttpClient;
  let driver: GarageIamDriver;
  let connection: ServerConnection;

  beforeEach(async () => {
    fixture = await startAdminFixture();
    http = new AdminHttpClient();
    driver = new GarageIamDriver(http);
    connection = fixtureConnection(fixture.baseUrl, {
      provider: 'garage',
      adminToken: 'garage-admin-token',
    });
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

  it('authenticates with the admin bearer token, not with SigV4', async () => {
    fixture.reply({ json: KEY_LIST });

    await driver.keys.list(connection);

    expect(lastRequest().headers['authorization']).toBe('Bearer garage-admin-token');
    expect(lastRequest().headers['x-amz-content-sha256']).toBeUndefined();
  });

  it('refuses to talk to a Garage server with no admin token, before any request', async () => {
    const tokenless = fixtureConnection(fixture.baseUrl, {
      provider: 'garage',
      adminToken: null,
    });

    await expect(driver.keys.list(tokenless)).rejects.toMatchObject({
      message: 'This server has no admin token, so its admin API cannot be used.',
    });
    expect(fixture.requests).toHaveLength(0);
  });

  it('lists keys with the bare ?list flag', async () => {
    fixture.reply({ json: KEY_LIST });

    const keys = await driver.keys.list(connection);

    expect(lastRequest().url).toBe('/v1/key?list');
    expect(keys).toEqual([
      {
        accessKeyId: 'GK31c2f218a2e44f485b94239e',
        userName: 'GK31c2f218a2e44f485b94239e',
        name: 'backups',
        enabled: true,
        restricted: false,
        createdAt: null,
        expiresAt: null,
        lastUsedAt: null,
      },
      {
        accessKeyId: 'GK9ac1cc0f6c4b47a8b2d23f10',
        userName: 'GK9ac1cc0f6c4b47a8b2d23f10',
        name: null,
        enabled: true,
        restricted: false,
        createdAt: null,
        expiresAt: null,
        lastUsedAt: null,
      },
    ]);
  });

  it('presents the same keys as users, named by their key id', async () => {
    fixture.reply({ json: KEY_LIST });

    const users = await driver.users.list(connection);

    expect(users.map((user) => user.name)).toEqual([
      'GK31c2f218a2e44f485b94239e',
      'GK9ac1cc0f6c4b47a8b2d23f10',
    ]);
    // Nothing to inherit and nothing to disable — stated, not implied.
    expect(users[0]).toMatchObject({ status: 'enabled', policies: [], memberOf: [] });
  });

  it('creates a key and returns the secret Garage gave once', async () => {
    fixture.reply({
      json: {
        accessKeyId: 'GKnewkey000000000000000000',
        secretAccessKey: 'shown-exactly-once',
        name: 'nightly',
      },
    });

    const created = await driver.keys.create(connection, {
      userName: 'nightly',
      name: 'nightly',
      description: null,
      expiresAt: '2030-01-01T00:00:00.000Z',
      policy: null,
    });

    const request = lastRequest();
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v1/key');
    expect(JSON.parse(request.body)).toEqual({ name: 'nightly' });
    expect(created).toEqual({
      accessKeyId: 'GKnewkey000000000000000000',
      secretAccessKey: 'shown-exactly-once',
      // Garage stores no expiry; the date stays with storage-io.
      expiresAt: null,
    });
  });

  it('fails loudly when Garage answers a create without a secret', async () => {
    fixture.reply({ json: { accessKeyId: 'GKnewkey000000000000000000' } });

    await expect(
      driver.keys.create(connection, {
        userName: 'nightly',
        name: 'nightly',
        description: null,
        expiresAt: null,
        policy: null,
      }),
    ).rejects.toMatchObject({
      message: 'Garage created a key without returning its secret.',
    });
  });

  it('renames a key, and does nothing when the patch carries no name', async () => {
    fixture.reply({ json: {} });
    await driver.keys.update?.(connection, 'GK31c2f218a2e44f485b94239e', 'unused', {
      name: 'renamed',
    });

    const request = lastRequest();
    expect(request.url).toBe('/v1/key?id=GK31c2f218a2e44f485b94239e');
    expect(JSON.parse(request.body)).toEqual({ name: 'renamed' });

    const before = fixture.requests.length;
    await driver.keys.update?.(connection, 'GK31c2f218a2e44f485b94239e', 'unused', {
      enabled: false,
    });
    // Garage has no enabled/disabled key; nothing is sent rather than something
    // being invented. The service refuses a status change before this point.
    expect(fixture.requests).toHaveLength(before);
  });

  it('deletes a key by id and treats a missing one as done', async () => {
    fixture.reply({ status: 204 });
    await driver.keys.delete(connection, 'GK31c2f218a2e44f485b94239e', 'unused');
    expect(lastRequest().method).toBe('DELETE');
    expect(lastRequest().url).toBe('/v1/key?id=GK31c2f218a2e44f485b94239e');

    fixture.reply({ status: 404, text: 'no such key' });
    await expect(driver.keys.delete(connection, 'GKgone', 'unused')).resolves.toBeUndefined();
  });

  it('offers no group or policy surface, which is the honest map', () => {
    // Read through the interface every caller uses, which is where the absence
    // has to be visible.
    const asSubDriver: IamSubDriver = driver;
    expect(asSubDriver.groups).toBeUndefined();
    expect(asSubDriver.policies).toBeUndefined();
  });
});
