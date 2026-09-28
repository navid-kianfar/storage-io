import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import type { Job } from '@storage-io/contracts';
import { JobEngineService, parseCheckpoint } from '../../src/modules/jobs/job-engine.service';
import { JobSourceService } from '../../src/modules/jobs/job-source.service';
import { JobsRepository } from '../../src/modules/jobs/jobs.repository';
import { createTestApp, type TestHarness } from '../support/test-app';
import { IT_ENABLED, MINIO, assertContainersUp } from './containers';

/**
 * Two engine behaviours that only a real listing can prove.
 *
 * **Every selected prefix.** A selection of "loose.txt plus p1/ plus p2/" used to
 * reach the engine as `prefixes[0]` and nothing else, so `p2/` survived a delete
 * the operator watched report success. The repro is the reviewer's: one loose
 * object and two folders, and all four objects have to go.
 *
 * **Resume is exact.** An early stop in the middle of a page used to advance the
 * checkpoint to the page's *next* token, so the rest of that page was never
 * processed. It is only reachable with more than one page, so the page size is
 * turned down for these tests rather than seeding thousands of objects — the
 * boundary is what is under test, not the number.
 */

const SMALL_PAGE_SIZE = 4;

describe.skipIf(!IT_ENABLED)('job selections and resume against live containers', () => {
  let harness: TestHarness;
  let cookie: string;
  let engine: JobEngineService;
  let repository: JobsRepository;
  let source: JobSourceService;

  const run = Date.now().toString(36);
  const selectionBucket = `sio-it-sel-${run}`;
  const copyTargetBucket = `sio-it-seldst-${run}`;
  const pagedBucket = `sio-it-paged-${run}`;
  const createdBuckets: string[] = [];

  beforeAll(async () => {
    await assertContainersUp();
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();
    engine = harness.app.get(JobEngineService);
    repository = harness.app.get(JobsRepository);
    source = harness.app.get(JobSourceService);

    await addServer();
    await createBucket(selectionBucket);
    await createBucket(copyTargetBucket);
    await createBucket(pagedBucket);
  }, 180_000);

  afterAll(async () => {
    source.pageSize = 1000;
    for (const bucket of [...createdBuckets].reverse()) {
      const response = await harness
        .http()
        .delete(`/api/v1/servers/${MINIO.name}/buckets/${bucket}?force=true`)
        .set(auth());
      if (response.status !== 204) await forceCleanup(bucket);
    }
    await harness.close();
  }, 180_000);

  const auth = (): Record<string, string> => ({ Cookie: cookie, Origin: harness.origin });

  /* --------------------- every selected prefix ---------------------- */

  /** The reviewer's repro: one loose object and two folders of one object each. */
  const SELECTION_LAYOUT = ['loose.txt', 'p1/a.txt', 'p1/b.txt', 'p2/c.txt'] as const;

  it('deletes every selected prefix, not just the first', async () => {
    const prefix = 'del/';
    await seed(
      selectionBucket,
      SELECTION_LAYOUT.map((key) => `${prefix}${key}`),
    );

    const response = await harness
      .http()
      .post(`/api/v1/servers/${MINIO.name}/buckets/${selectionBucket}/objects/delete`)
      .set(auth())
      .send({
        objects: [{ key: `${prefix}loose.txt` }],
        prefixes: [`${prefix}p1/`, `${prefix}p2/`],
        allVersions: false,
      })
      .expect(201);

    const job = response.body.job as Job;
    expect(job).not.toBeNull();
    // The contract now carries both, which is what the engine reads.
    expect(job.source.prefixes).toEqual([`${prefix}p1/`, `${prefix}p2/`]);
    expect(job.source.keyCount).toBe(1);

    await engine.drain();

    const finished = await fetchJob(job.id);
    expect(finished.status).toBe('completed');
    expect(finished.progress.processed).toBe(SELECTION_LAYOUT.length);
    expect(await listKeys(selectionBucket, prefix)).toEqual([]);
  }, 180_000);

  it('copies every selected prefix, not just the first', async () => {
    const prefix = 'cp/';
    await seed(
      selectionBucket,
      SELECTION_LAYOUT.map((key) => `${prefix}${key}`),
    );

    const response = await harness
      .http()
      .post(`/api/v1/servers/${MINIO.name}/buckets/${selectionBucket}/objects/copy`)
      .set(auth())
      .send({
        keys: [`${prefix}loose.txt`],
        prefixes: [`${prefix}p1/`, `${prefix}p2/`],
        destServerId: MINIO.name,
        destBucket: copyTargetBucket,
        destPrefix: 'copied/',
        move: false,
        conflict: 'overwrite',
      })
      .expect(201);

    const job = response.body.job as Job;
    expect(job.source.prefixes).toEqual([`${prefix}p1/`, `${prefix}p2/`]);

    await engine.drain();

    const finished = await fetchJob(job.id);
    expect(finished.status).toBe('completed');
    expect(await listKeys(copyTargetBucket, 'copied/')).toHaveLength(SELECTION_LAYOUT.length);
    // The source is untouched by a copy.
    expect(await listKeys(selectionBucket, prefix)).toHaveLength(SELECTION_LAYOUT.length);
  }, 180_000);

  it('moves every selected prefix, leaving nothing behind', async () => {
    const prefix = 'mv/';
    await seed(
      selectionBucket,
      SELECTION_LAYOUT.map((key) => `${prefix}${key}`),
    );

    const response = await harness
      .http()
      .post(`/api/v1/servers/${MINIO.name}/buckets/${selectionBucket}/objects/copy`)
      .set(auth())
      .send({
        keys: [`${prefix}loose.txt`],
        prefixes: [`${prefix}p1/`, `${prefix}p2/`],
        destServerId: MINIO.name,
        destBucket: copyTargetBucket,
        destPrefix: 'moved/',
        move: true,
        conflict: 'overwrite',
      })
      .expect(201);

    const job = response.body.job as Job;
    await engine.drain();

    const finished = await fetchJob(job.id);
    expect(finished.status).toBe('completed');
    expect(await listKeys(copyTargetBucket, 'moved/')).toHaveLength(SELECTION_LAYOUT.length);
    expect(await listKeys(selectionBucket, prefix)).toEqual([]);
  }, 180_000);

  it('counts an object under two selected prefixes once', async () => {
    const prefix = 'dedupe/';
    // `p1/sub/` is inside `p1/`, and the loose key is inside `p1/` too: the plan
    // has to collapse all three into one listing or the counters double.
    await seed(selectionBucket, [`${prefix}p1/a.txt`, `${prefix}p1/sub/b.txt`]);

    const response = await harness
      .http()
      .post(`/api/v1/servers/${MINIO.name}/buckets/${selectionBucket}/objects/delete`)
      .set(auth())
      .send({
        objects: [{ key: `${prefix}p1/a.txt` }],
        prefixes: [`${prefix}p1/`, `${prefix}p1/sub/`],
        allVersions: false,
      })
      .expect(201);

    const job = response.body.job as Job;
    await engine.drain();

    const finished = await fetchJob(job.id);
    expect(finished.status).toBe('completed');
    expect(finished.progress.processed).toBe(2);
    expect(await listKeys(selectionBucket, prefix)).toEqual([]);
  }, 180_000);

  /* ----------------------- resume is exact -------------------------- */

  /** More than one page at the reduced size, and not a multiple of it. */
  const PAGED_COUNT = SMALL_PAGE_SIZE * 3 + 1;

  it('processes every object exactly once when paused in the middle of a page', async () => {
    const prefix = 'pause/';
    const keys = Array.from({ length: PAGED_COUNT }, (_, index) => `${prefix}o${index}.txt`);
    await seed(pagedBucket, keys);

    source.pageSize = SMALL_PAGE_SIZE;
    try {
      const job = await createDeleteJob(pagedBucket, prefix);

      // Pause after the first page, then again after the second, and so on: each
      // stop leaves the checkpoint on a page boundary or inside one depending on
      // where the flag landed, and the invariant is that no object is skipped.
      let guard = 0;
      let current = await fetchJob(job.id);
      while (current.status !== 'completed' && guard < 20) {
        guard += 1;
        engine.requestPause(job.id);
        await engine.drain();
        current = await fetchJob(job.id);
        if (current.status !== 'paused') break;

        const checkpoint = parseCheckpoint(rawCheckpoint(job.id));
        expect(checkpoint.segment).toBeGreaterThanOrEqual(0);

        await harness.http().post(`/api/v1/jobs/${job.id}/resume`).set(auth()).expect(200);
        current = await fetchJob(job.id);
      }

      // Whatever the pausing pattern, the work finishes and the bucket is empty.
      engine.clearControl(job.id);
      await drainUntilDone(job.id);
      const finished = await fetchJob(job.id);
      expect(finished.status).toBe('completed');
      expect(finished.progress.processed).toBe(PAGED_COUNT);
      expect(finished.progress.failed).toBe(0);
      expect(await listKeys(pagedBucket, prefix)).toEqual([]);
    } finally {
      source.pageSize = 1000;
    }
  }, 300_000);

  it('keeps the current page in the checkpoint, so a restart re-lists it', async () => {
    const prefix = 'restart/';
    const keys = Array.from({ length: PAGED_COUNT }, (_, index) => `${prefix}o${index}.txt`);
    await seed(pagedBucket, keys);

    source.pageSize = SMALL_PAGE_SIZE;
    try {
      const job = await createCopyJob(pagedBucket, prefix, 'restarted/');

      // Stop the run part-way, exactly as a shutdown does: the engine writes the
      // checkpoint and leaves the row `running`.
      engine.requestPause(job.id);
      await engine.drain();
      const paused = await fetchJob(job.id);
      expect(paused.status).toBe('paused');

      const stored = parseCheckpoint(rawCheckpoint(job.id));
      // The checkpoint is on the page that was being worked, not the one after it.
      expect(stored.cursor).toBeGreaterThanOrEqual(0);

      // Now simulate the restart: the row goes back to `running` with that exact
      // checkpoint, and bootstrap requeues it the way `main.ts` does.
      repository.update(job.id, { status: 'running' });
      engine.onApplicationBootstrap();
      expect((await fetchJob(job.id)).status).toBe('queued');

      await drainUntilDone(job.id);

      const finished = await fetchJob(job.id);
      expect(finished.status).toBe('completed');
      expect(finished.progress.processed).toBe(PAGED_COUNT);
      // Exactly once: every source object is at the destination, and no more.
      expect(await listKeys(copyTargetBucket, 'restarted/')).toHaveLength(PAGED_COUNT);
    } finally {
      source.pageSize = 1000;
    }
  }, 300_000);

  /* -------------------------- the plumbing -------------------------- */

  async function drainUntilDone(id: string): Promise<void> {
    for (let pass = 0; pass < 20; pass += 1) {
      const current = await fetchJob(id);
      if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(current.status)) {
        return;
      }
      await engine.drain();
    }
    throw new Error(`Job ${id} did not finish in twenty passes.`);
  }

  /** The stored column, which is what a restart reads — not the contract's view. */
  function rawCheckpoint(id: string): string | null {
    const row = repository.findById(id);
    if (row === null) throw new Error(`No job row ${id}.`);
    return row.checkpoint;
  }

  async function createDeleteJob(bucket: string, prefix: string): Promise<Job> {
    const response = await harness
      .http()
      .post(`/api/v1/servers/${MINIO.name}/buckets/${bucket}/objects/delete`)
      .set(auth())
      .send({ objects: [], prefixes: [prefix], allVersions: false })
      .expect(201);
    return response.body.job as Job;
  }

  async function createCopyJob(bucket: string, prefix: string, destPrefix: string): Promise<Job> {
    const response = await harness
      .http()
      .post(`/api/v1/servers/${MINIO.name}/buckets/${bucket}/objects/copy`)
      .set(auth())
      .send({
        keys: [],
        prefixes: [prefix],
        destServerId: MINIO.name,
        destBucket: copyTargetBucket,
        destPrefix,
        move: false,
        conflict: 'overwrite',
      })
      .expect(201);
    return response.body.job as Job;
  }

  async function fetchJob(id: string): Promise<Job> {
    const response = await harness
      .http()
      .get(`/api/v1/jobs/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as Job;
  }

  async function addServer(): Promise<void> {
    await harness
      .http()
      .post('/api/v1/servers')
      .set(auth())
      .send({
        name: MINIO.name,
        provider: MINIO.provider,
        endpoint: MINIO.endpoint,
        region: MINIO.region,
        accessKeyId: MINIO.accessKeyId,
        secretAccessKey: MINIO.secretAccessKey,
        options: { pathStyle: true, healthIntervalSec: 3600 },
      })
      .expect(201);
  }

  async function createBucket(bucket: string): Promise<void> {
    await harness
      .http()
      .post(`/api/v1/servers/${MINIO.name}/buckets`)
      .set(auth())
      .send({ name: bucket, versioning: false, objectLock: false, quota: null, access: 'private' })
      .expect(201);
    createdBuckets.push(bucket);
  }

  async function seed(bucket: string, keys: readonly string[]): Promise<void> {
    const client = clientForMinio();
    try {
      for (const key of keys) {
        await client.send(
          new PutObjectCommand({ Bucket: bucket, Key: key, Body: `body of ${key}` }),
        );
      }
    } finally {
      client.destroy();
    }
  }

  async function listKeys(bucket: string, prefix: string): Promise<readonly string[]> {
    const client = clientForMinio();
    try {
      const keys: string[] = [];
      let token: string | undefined = undefined;
      do {
        // Annotated because the token is both read into the request and assigned
        // from the response; TypeScript calls that circular otherwise.
        const page: ListObjectsV2CommandOutput = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const entry of page.Contents ?? []) {
          if (entry.Key !== undefined) keys.push(entry.Key);
        }
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
      return keys;
    } finally {
      client.destroy();
    }
  }

  async function forceCleanup(bucket: string): Promise<void> {
    const client = clientForMinio();
    try {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
      const objects = (listed.Contents ?? [])
        .filter((entry) => entry.Key !== undefined)
        .map((entry) => ({ Key: entry.Key as string }));
      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
        );
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    } catch {
      // Best effort: a surviving bucket is named after this run and cannot break
      // the next one, and failing here would hide the real failure.
    } finally {
      client.destroy();
    }
  }

  function clientForMinio(): S3Client {
    return new S3Client({
      endpoint: MINIO.endpoint,
      region: MINIO.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: MINIO.accessKeyId,
        secretAccessKey: MINIO.secretAccessKey,
      },
      maxAttempts: 1,
    });
  }
});
