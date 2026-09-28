import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderRegistryService } from '../../src/providers/provider-registry.service';
import { ServerRepository } from '../../src/servers/server.repository';
import { TrafficSamplerService } from '../../src/servers/traffic-sampler.service';
import { createTestApp, type TestHarness } from '../support/test-app';
import { IT_ENABLED, MINIO, assertContainersUp } from './containers';

/**
 * The traffic chart against a real MinIO.
 *
 * This is the one claim in the traffic work that cannot be made without a
 * container: that the JWT storage-io mints — the same one
 * `mc admin prometheus generate` prints — is actually accepted by
 * `/minio/v2/metrics/cluster`, and that the counter names parsed out of the reply
 * are the ones this MinIO emits. The arithmetic on top of it is unit-tested;
 * everything here is about the wire.
 */
describe.skipIf(!IT_ENABLED)('traffic metrics against live MinIO', () => {
  let harness: TestHarness;
  let cookie: string;
  let sampler: TrafficSamplerService;
  let servers: ServerRepository;
  let registry: ProviderRegistryService;

  const serverName = `sio-it-traffic-${Date.now().toString(36)}`;

  beforeAll(async () => {
    await assertContainersUp();
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();
    sampler = harness.app.get(TrafficSamplerService);
    servers = harness.app.get(ServerRepository);
    registry = harness.app.get(ProviderRegistryService);

    await harness
      .http()
      .post('/api/v1/servers')
      .set({ Cookie: cookie, Origin: harness.origin })
      .send({
        name: serverName,
        provider: MINIO.provider,
        endpoint: MINIO.endpoint,
        region: MINIO.region,
        accessKeyId: MINIO.accessKeyId,
        secretAccessKey: MINIO.secretAccessKey,
        options: { pathStyle: true, healthIntervalSec: 3600 },
      })
      .expect(201);
  }, 120_000);

  afterAll(async () => {
    await harness
      .http()
      .delete(`/api/v1/servers/${serverName}`)
      .set({ Cookie: cookie, Origin: harness.origin });
    await harness.close();
  });

  it('reports the traffic capability as supported once the admin surface answered', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/servers/${serverName}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body.capabilities.traffic).toBe('supported');
  });

  it('reads MinIO’s Prometheus counters with a self-minted bearer token', async () => {
    const row = servers.findByIdOrName(serverName);
    expect(row).not.toBeNull();
    const connection = servers.toConnection(row!);

    const driver = registry.trafficIfAny(connection);
    expect(driver).not.toBeNull();

    const counters = await driver!.sample(connection);
    // Null would mean the endpoint answered with none of the four counters, which
    // is how a wrong metric name would show up.
    expect(counters).not.toBeNull();
    expect(counters).toMatchObject({
      requests: expect.any(Number),
      errors: expect.any(Number),
      rxBytes: expect.any(Number),
      txBytes: expect.any(Number),
    });
    expect(counters!.requests).toBeGreaterThan(0);
  }, 60_000);

  it('turns two samples into a per-second series the metrics endpoint serves', async () => {
    const row = servers.findByIdOrName(serverName);
    const connection = servers.toConnection(row!);

    // The first sample has no rate — there is nothing to subtract from.
    await sampler.sample(row!, connection);
    const first = await harness
      .http()
      .get(`/api/v1/servers/${serverName}/metrics?range=24h`)
      .set('Cookie', cookie)
      .expect(200);
    expect(first.body.traffic).toEqual([]);

    // Make some S3 traffic of our own, then sample again.
    //
    // The wait is **not** the sampler's one-second floor: MinIO caches its cluster
    // metrics for about ten seconds, so a scrape taken immediately after a request
    // still reports the old counter. Verified against the dev container
    // (DEVELOPMENT.2025-05-24T17-08-30Z): `minio_s3_requests_total` moved between
    // the +5 s and +11 s scrapes and not before.
    const client = new S3Client({
      endpoint: MINIO.endpoint,
      region: MINIO.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: MINIO.accessKeyId,
        secretAccessKey: MINIO.secretAccessKey,
      },
    });
    try {
      for (let index = 0; index < 30; index += 1) {
        await client.send(new ListBucketsCommand({}));
      }
    } finally {
      client.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    await sampler.sample(row!, connection);

    const second = await harness
      .http()
      .get(`/api/v1/servers/${serverName}/metrics?range=24h`)
      .set('Cookie', cookie)
      .expect(200);

    expect(second.body.traffic).toHaveLength(1);
    expect(second.body.traffic[0]).toMatchObject({
      t: expect.any(String),
      requestsPerSec: expect.any(Number),
      errorsPerSec: expect.any(Number),
      rxBytesPerSec: expect.any(Number),
      txBytesPerSec: expect.any(Number),
    });
    expect(second.body.traffic[0].requestsPerSec).toBeGreaterThan(0);
  }, 60_000);

  it('reports null traffic for a provider with no metrics endpoint', async () => {
    const name = `${serverName}-generic`;
    await harness
      .http()
      .post('/api/v1/servers')
      .set({ Cookie: cookie, Origin: harness.origin })
      .send({
        name,
        provider: 'generic',
        endpoint: MINIO.endpoint,
        region: MINIO.region,
        accessKeyId: MINIO.accessKeyId,
        secretAccessKey: MINIO.secretAccessKey,
        options: { pathStyle: true, healthIntervalSec: 3600 },
      })
      .expect(201);

    try {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${name}/metrics?range=24h`)
        .set('Cookie', cookie)
        .expect(200);

      // `null`, not `[]`: an empty series would draw as a flat line at zero
      // requests per second, which is a different and false claim.
      expect(response.body.traffic).toBeNull();
      expect(response.body.capacity).toEqual([]);
    } finally {
      await harness
        .http()
        .delete(`/api/v1/servers/${name}`)
        .set({ Cookie: cookie, Origin: harness.origin });
    }
  }, 60_000);
});
