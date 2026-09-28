/**
 * The dev containers from `docker/docker-compose.dev.yml`. These credentials are
 * fixed there on purpose so the integration suite needs no discovery step.
 *
 *   docker compose -f docker/docker-compose.dev.yml up -d
 *   S3_IT=1 pnpm --filter @storage-io/api test:it
 *
 * Without `S3_IT=1` every spec in this folder skips, so `pnpm test` stays green
 * on a machine with no Docker.
 */

export const IT_ENABLED = process.env['S3_IT'] === '1';

export const MINIO = {
  name: 'it-minio',
  provider: 'minio',
  endpoint: process.env['IT_MINIO_ENDPOINT'] ?? 'http://127.0.0.1:9000',
  region: 'us-east-1',
  accessKeyId: 'sio-dev-admin',
  secretAccessKey: 'sio-dev-secret-key',
} as const;

export const SEAWEEDFS = {
  name: 'it-seaweedfs',
  provider: 'seaweedfs',
  endpoint: process.env['IT_SEAWEEDFS_ENDPOINT'] ?? 'http://127.0.0.1:8333',
  iamEndpoint: process.env['IT_SEAWEEDFS_IAM_ENDPOINT'] ?? 'http://127.0.0.1:8111',
  region: 'us-east-1',
  accessKeyId: 'sio-dev-seaweed',
  secretAccessKey: 'sio-dev-seaweed-secret',
} as const;

/**
 * A pre-flight so a missing container fails with a sentence rather than a
 * timeout in the middle of a test.
 */
export async function assertContainersUp(): Promise<void> {
  const probes: readonly { readonly label: string; readonly url: string }[] = [
    { label: 'MinIO', url: `${MINIO.endpoint}/minio/health/live` },
    // SeaweedFS answers 403 to an unsigned S3 request, which is proof enough
    // that it is listening.
    { label: 'SeaweedFS', url: SEAWEEDFS.endpoint },
  ];

  for (const probe of probes) {
    try {
      const response = await fetch(probe.url, { signal: AbortSignal.timeout(3_000) });
      if (response.status >= 500) {
        throw new Error(`${probe.label} answered HTTP ${response.status}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${probe.label} is not reachable at ${probe.url} (${reason}). Start it with:\n` +
          '  docker compose -f docker/docker-compose.dev.yml up -d',
      );
    }
  }
}
