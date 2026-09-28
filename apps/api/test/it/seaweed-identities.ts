import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { SEAWEEDFS } from './containers';

/**
 * Protecting the dev SeaweedFS's documented credentials from the integration
 * suite.
 *
 * ## Why this exists
 *
 * `docker/seaweedfs/s3.json` seeds one identity — `sio-dev-admin`, with the fixed
 * key `test/it/containers.ts` uses. SeaweedFS reads that file **once, at start**,
 * and copies it into the filer at `/etc/iam/identity.json`; from then on the
 * filer's copy is the live store and the IAM-compatible API rewrites it whole. So
 * a `DeleteUser` through that API can take the seeded admin identity with it, and
 * when it does, every integration test and every developer's saved connection
 * stops authenticating with no obvious cause. That happened once.
 *
 * ## What it does about it
 *
 * `snapshotIdentities` reads the filer's copy before the suite touches IAM;
 * `restoreIdentities` puts it back afterwards and then **proves the credentials
 * work** with a signed `ListBuckets`. The proof is the point: writing the file back
 * is best effort, and only the round trip says whether the container recovered.
 *
 * If it did not, the error names the one command that fixes it, because a
 * developer hitting this has no way to guess it:
 *
 * ```
 * docker compose -f docker/docker-compose.dev.yml restart seaweedfs
 * ```
 *
 * Verified against `chrislusf/seaweedfs:3.97`: the filer serves and accepts
 * `/etc/iam/identity.json` on :8888 with no authentication, and a write there is
 * picked up by the S3 gateway without a restart.
 */

const FILER_ENDPOINT = process.env['IT_SEAWEEDFS_FILER_ENDPOINT'] ?? 'http://127.0.0.1:8888';
const IDENTITY_PATH = '/etc/iam/identity.json';
const REQUEST_TIMEOUT_MS = 5_000;

export const RESTART_HINT = 'docker compose -f docker/docker-compose.dev.yml restart seaweedfs';

/** The filer's identity config, or null when it could not be read. */
export async function snapshotIdentities(): Promise<string | null> {
  try {
    const response = await fetch(`${FILER_ENDPOINT}${IDENTITY_PATH}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.text();
    // An empty body is not a snapshot worth restoring — writing it back would be
    // the very damage this guards against.
    return body.trim().length === 0 ? null : body;
  } catch {
    return null;
  }
}

/**
 * Writes the snapshot back if the documented credentials have stopped working, and
 * throws when they still do not. A working container is left untouched: a write
 * that is not needed is a write that can go wrong.
 */
export async function restoreIdentities(snapshot: string | null): Promise<void> {
  if (await credentialsWork()) return;

  if (snapshot !== null) {
    await writeIdentities(snapshot);
    if (await credentialsWork()) return;
  }

  throw new Error(
    `The SeaweedFS dev identity (${SEAWEEDFS.accessKeyId}) no longer authenticates and could not be restored. ` +
      `Recover the documented credentials with:\n  ${RESTART_HINT}`,
  );
}

/** A signed `ListBuckets` — the only thing that actually proves the key works. */
export async function credentialsWork(): Promise<boolean> {
  const client = new S3Client({
    endpoint: SEAWEEDFS.endpoint,
    region: SEAWEEDFS.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: SEAWEEDFS.accessKeyId,
      secretAccessKey: SEAWEEDFS.secretAccessKey,
    },
  });
  try {
    await client.send(new ListBucketsCommand({}));
    return true;
  } catch {
    return false;
  } finally {
    client.destroy();
  }
}

async function writeIdentities(snapshot: string): Promise<void> {
  const form = new FormData();
  form.append('file', new Blob([snapshot], { type: 'application/json' }), 'identity.json');
  try {
    await fetch(`${FILER_ENDPOINT}${IDENTITY_PATH}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // The caller re-checks the credentials and raises the actionable error; a
    // failure here says nothing more than that check will.
  }
}
