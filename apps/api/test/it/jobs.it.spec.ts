import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { JOB_FILTER_DEFAULTS, type Job } from '@storage-io/contracts';
import { JobEngineService } from '../../src/modules/jobs/job-engine.service';
import { JobsRepository } from '../../src/modules/jobs/jobs.repository';
import { createTestApp, type TestHarness } from '../support/test-app';
import { IT_ENABLED, MINIO, SEAWEEDFS, assertContainersUp } from './containers';

/**
 * The job engine against the real containers.
 *
 * The e2e suite proves the contract and the state machine with no server
 * reachable. These prove the only things a mock cannot:
 *
 * - that a copy job **actually moves a few hundred objects** from MinIO to
 *   SeaweedFS, across two different S3 implementations;
 * - that pause leaves a resumable checkpoint and resume finishes the job, with
 *   every object copied exactly once;
 * - that a job the process died inside **resumes from its checkpoint** rather than
 *   starting over or skipping the page it was on;
 * - that a dry run counts what it would touch and changes nothing;
 * - that a delete job with `includeVersions` removes delete markers too, which is
 *   the difference between a bucket that can be deleted and one that cannot.
 *
 * The engine is driven with `drain()` rather than by its interval: a background
 * tick would claim a row in the middle of an assertion about that row.
 */

/** Enough to span several listing pages of the engine's own batching. */
const OBJECT_COUNT = 260;

describe.skipIf(!IT_ENABLED)('jobs against live containers', () => {
  let harness: TestHarness;
  let cookie: string;
  let engine: JobEngineService;
  let repository: JobsRepository;

  const run = Date.now().toString(36);
  const sourceBucket = `sio-it-jobsrc-${run}`;
  const targetBucket = `sio-it-jobdst-${run}`;
  const versionedBucket = `sio-it-jobver-${run}`;
  const createdBuckets: { server: string; bucket: string }[] = [];

  beforeAll(async () => {
    await assertContainersUp();
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();
    engine = harness.app.get(JobEngineService);
    repository = harness.app.get(JobsRepository);

    await addServer(MINIO);
    await addServer(SEAWEEDFS);

    await createBucket(MINIO.name, sourceBucket);
    await createBucket(SEAWEEDFS.name, targetBucket);
    await createBucket(MINIO.name, versionedBucket, { versioning: true });

    await seedObjects();
  }, 180_000);

  afterAll(async () => {
    for (const entry of createdBuckets.reverse()) {
      const response = await harness
        .http()
        .delete(`/api/v1/servers/${entry.server}/buckets/${entry.bucket}?force=true`)
        .set(auth());
      if (response.status !== 204) await forceCleanup(entry.server, entry.bucket);
    }
    await harness.close();
  }, 180_000);

  const auth = (): Record<string, string> => ({ Cookie: cookie, Origin: harness.origin });

  /* ------------------------------- the tests ------------------------ */

  it('copies a few hundred objects from MinIO to SeaweedFS', async () => {
    const job = await createJob({
      name: 'copy everything',
      type: 'copy',
      source: { serverId: MINIO.name, bucket: sourceBucket, filters: { ...JOB_FILTER_DEFAULTS } },
      target: { serverId: SEAWEEDFS.name, bucket: targetBucket, prefix: 'copied/' },
      options: { conflict: 'overwrite', concurrency: 8, dryRun: false },
    });

    await engine.drain();
    const finished = await fetchJob(job.id);

    expect(finished.status).toBe('completed');
    expect(finished.progress.processed).toBe(OBJECT_COUNT);
    expect(finished.progress.failed).toBe(0);
    expect(finished.progress.bytes).toBeGreaterThan(0);
    // The checkpoint is cleared on a clean finish; a stale one would make a
    // re-run start in the middle.
    expect(finished.waitingFor).toBeNull();

    // What the operator actually asked for: the objects are on the other server.
    const copied = await listKeys(SEAWEEDFS, targetBucket, 'copied/');
    expect(copied).toHaveLength(OBJECT_COUNT);
    expect(copied).toContain(`copied/data/object-000.bin`);
  }, 300_000);

  it('a dry run counts what it would touch and changes nothing', async () => {
    const before = await listKeys(SEAWEEDFS, targetBucket, 'dry/');
    expect(before).toHaveLength(0);

    const job = await createJob({
      name: 'dry run',
      type: 'copy',
      source: {
        serverId: MINIO.name,
        bucket: sourceBucket,
        filters: { ...JOB_FILTER_DEFAULTS, prefix: 'data/object-00' },
      },
      target: { serverId: SEAWEEDFS.name, bucket: targetBucket, prefix: 'dry/' },
      options: { conflict: 'overwrite', concurrency: 4, dryRun: true },
    });

    await engine.drain();
    const finished = await fetchJob(job.id);

    // `data/object-000.bin` … `data/object-009.bin`
    expect(finished.status).toBe('completed');
    expect(finished.progress.processed).toBe(10);
    expect(await listKeys(SEAWEEDFS, targetBucket, 'dry/')).toHaveLength(0);
  }, 120_000);

  it('applies a size filter, so only the matching objects are touched', async () => {
    const job = await createJob({
      name: 'big ones only',
      type: 'copy',
      source: {
        serverId: MINIO.name,
        bucket: sourceBucket,
        // Only the ten `large/` objects are over 4 KiB.
        filters: { ...JOB_FILTER_DEFAULTS, minSize: 4096 },
      },
      target: { serverId: SEAWEEDFS.name, bucket: targetBucket, prefix: 'big/' },
      options: { conflict: 'overwrite', concurrency: 4, dryRun: false },
    });

    await engine.drain();
    const finished = await fetchJob(job.id);

    expect(finished.status).toBe('completed');
    expect(finished.progress.processed).toBe(10);
    const copied = await listKeys(SEAWEEDFS, targetBucket, 'big/');
    expect(copied.every((key) => key.includes('large/'))).toBe(true);
  }, 120_000);

  it('pauses mid-run, keeps a checkpoint, and resumes to a complete copy', async () => {
    const job = await createJob({
      name: 'pause and resume',
      type: 'copy',
      source: { serverId: MINIO.name, bucket: sourceBucket, filters: { ...JOB_FILTER_DEFAULTS } },
      target: { serverId: SEAWEEDFS.name, bucket: targetBucket, prefix: 'resumed/' },
      options: { conflict: 'overwrite', concurrency: 2, dryRun: false },
    });

    // Pause it before it starts: the engine takes the flag at the top of its first
    // page, which is the same code path as a pause during a long run and needs no
    // racing against real object copies.
    await harness.http().post(`/api/v1/jobs/${job.id}/pause`).set(auth()).expect(200);
    await engine.drain();

    let current = await fetchJob(job.id);
    expect(current.status).toBe('paused');
    expect(await listKeys(SEAWEEDFS, targetBucket, 'resumed/')).toHaveLength(0);

    await harness.http().post(`/api/v1/jobs/${job.id}/resume`).set(auth()).expect(200);
    await engine.drain();

    current = await fetchJob(job.id);
    expect(current.status).toBe('completed');
    expect(current.progress.processed).toBe(OBJECT_COUNT);
    expect(await listKeys(SEAWEEDFS, targetBucket, 'resumed/')).toHaveLength(OBJECT_COUNT);
  }, 300_000);

  it('cancels a queued job and leaves what was already done alone', async () => {
    const job = await createJob({
      name: 'cancelled before it ran',
      type: 'copy',
      source: { serverId: MINIO.name, bucket: sourceBucket, filters: { ...JOB_FILTER_DEFAULTS } },
      target: { serverId: SEAWEEDFS.name, bucket: targetBucket, prefix: 'cancelled/' },
      options: { conflict: 'overwrite', concurrency: 4, dryRun: false },
    });

    await harness.http().post(`/api/v1/jobs/${job.id}/cancel`).set(auth()).expect(200);
    await engine.drain();

    const finished = await fetchJob(job.id);
    expect(finished.status).toBe('cancelled');
    expect(await listKeys(SEAWEEDFS, targetBucket, 'cancelled/')).toHaveLength(0);
  }, 120_000);

  it('resumes from its checkpoint after a restart, copying every object exactly once', async () => {
    const job = await createJob({
      name: 'interrupted',
      type: 'copy',
      source: { serverId: MINIO.name, bucket: sourceBucket, filters: { ...JOB_FILTER_DEFAULTS } },
      target: { serverId: SEAWEEDFS.name, bucket: targetBucket, prefix: 'restart/' },
      options: { conflict: 'skip', concurrency: 8, dryRun: false },
    });

    // The engine lists a whole page (1000 keys) at a time, so a 260-object bucket
    // finishes in one page. To exercise resume, the run is stopped after the first
    // half is copied by hand and the row is left exactly as a crash would leave it:
    // `running`, with the listing's continuation token and the counters it had.
    const half = Math.floor(OBJECT_COUNT / 2);
    const keys = await listKeys(MINIO, sourceBucket, '');
    const firstHalf = keys.slice(0, half);
    await copyByHand(firstHalf, 'restart/');

    repository.update(job.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
      // A null checkpoint is what a crash on the very first page leaves behind, and
      // it is the harder case: the whole listing is replayed, so the already-copied
      // half must be recognised rather than copied twice.
      checkpoint: null,
      progress: { ...job.progress, processed: half },
    });

    // Exactly what `main.ts` does on the way up.
    engine.onApplicationBootstrap();

    const requeued = await fetchJob(job.id);
    expect(requeued.status).toBe('queued');
    expect(requeued.waitingFor).toContain('restart');

    await engine.drain();

    const finished = await fetchJob(job.id);
    expect(['completed', 'completed_with_errors']).toContain(finished.status);
    // `conflict: 'skip'` means the replayed half is skipped rather than recopied,
    // and nothing is lost either way: every object is at the destination once.
    expect(finished.progress.skipped).toBeGreaterThanOrEqual(half);
    const copied = await listKeys(SEAWEEDFS, targetBucket, 'restart/');
    expect(copied).toHaveLength(OBJECT_COUNT);

    const log = await harness
      .http()
      .get(`/api/v1/jobs/${job.id}/logs`)
      .set('Cookie', cookie)
      .expect(200);
    expect(JSON.stringify(log.body.items)).toContain('restarted');
  }, 300_000);

  it('deletes every version and delete marker when includeVersions is set', async () => {
    const client = clientFor(MINIO);
    try {
      // Two versions of one key, then a delete marker on top of it.
      for (const round of [1, 2]) {
        await client.send(
          new PutObjectCommand({
            Bucket: versionedBucket,
            Key: 'versioned.txt',
            Body: `round ${round}`,
          }),
        );
      }
      await harness
        .http()
        .post(`/api/v1/servers/${MINIO.name}/buckets/${versionedBucket}/objects/delete`)
        .set(auth())
        .send({ objects: [{ key: 'versioned.txt' }], prefixes: [], allVersions: false })
        .expect(201);

      const before = await listVersions(MINIO, versionedBucket);
      expect(before.versions).toBeGreaterThanOrEqual(2);
      expect(before.markers).toBeGreaterThanOrEqual(1);

      const job = await createJob({
        name: 'purge versions',
        type: 'delete',
        source: {
          serverId: MINIO.name,
          bucket: versionedBucket,
          filters: { ...JOB_FILTER_DEFAULTS },
        },
        params: { includeVersions: true },
        options: { conflict: 'overwrite', concurrency: 4, dryRun: false },
      });

      await engine.drain();
      const finished = await fetchJob(job.id);

      expect(finished.status).toBe('completed');
      expect(finished.progress.processed).toBe(before.versions + before.markers);

      const after = await listVersions(MINIO, versionedBucket);
      // Deleting only current versions would leave the bucket full and
      // `DeleteBucket` would still fail — this is that difference.
      expect(after.versions + after.markers).toBe(0);
    } finally {
      client.destroy();
    }
  }, 180_000);

  it('writes per-object failures to the log without failing the whole job', async () => {
    // A copy into a bucket that does not exist: every object fails, so the run is
    // `failed` and the first failures are named in the log.
    //
    // The target is MinIO, not SeaweedFS: SeaweedFS creates a bucket on the first
    // PutObject into it, so a missing bucket there is not an error at all — which
    // is worth knowing and is why this test would otherwise pass by accident.
    const job = await createJob({
      name: 'nowhere to put it',
      type: 'copy',
      source: {
        serverId: MINIO.name,
        bucket: sourceBucket,
        filters: { ...JOB_FILTER_DEFAULTS, prefix: 'data/object-00' },
      },
      target: { serverId: MINIO.name, bucket: `sio-it-nosuch-${run}`, prefix: '' },
      options: { conflict: 'overwrite', concurrency: 4, dryRun: false },
    });

    await engine.drain();
    const finished = await fetchJob(job.id);

    expect(finished.status).toBe('failed');
    expect(finished.progress.failed).toBe(10);
    expect(finished.progress.processed).toBe(0);

    const log = await harness
      .http()
      .get(`/api/v1/jobs/${job.id}/logs?level=error`)
      .set('Cookie', cookie)
      .expect(200);
    expect(log.body.items.length).toBeGreaterThan(0);
    expect(log.body.items[0]).toMatchObject({ level: 'error', key: expect.any(String) });
    // Nothing internal crosses the boundary in a message an operator reads.
    expect(JSON.stringify(log.body.items)).not.toContain('at Object.');
  }, 180_000);

  it('estimates the source without listing it to the end', async () => {
    const response = await harness
      .http()
      .post('/api/v1/jobs/estimate')
      .set(auth())
      .send({
        source: { serverId: MINIO.name, bucket: sourceBucket, filters: { ...JOB_FILTER_DEFAULTS } },
      })
      .expect(200);

    expect(response.body).toMatchObject({
      objects: OBJECT_COUNT,
      bytes: expect.any(Number),
      partial: false,
    });
    expect(response.body.bytes).toBeGreaterThan(0);
  }, 120_000);

  it('tags matching objects and leaves their existing tags in place', async () => {
    const client = clientFor(MINIO);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: sourceBucket,
          Key: 'tagme/one.txt',
          Body: 'x',
          Tagging: 'keep=yes',
        }),
      );

      const job = await createJob({
        name: 'tag them',
        type: 'tag',
        source: {
          serverId: MINIO.name,
          bucket: sourceBucket,
          filters: { ...JOB_FILTER_DEFAULTS, prefix: 'tagme/' },
        },
        params: { tags: { tier: 'cold' } },
        options: { conflict: 'overwrite', concurrency: 2, dryRun: false },
      });

      await engine.drain();
      expect((await fetchJob(job.id)).status).toBe('completed');

      const tags = await harness
        .http()
        .get(
          `/api/v1/servers/${MINIO.name}/buckets/${sourceBucket}/objects/tags?key=${encodeURIComponent('tagme/one.txt')}`,
        )
        .set('Cookie', cookie)
        .expect(200);

      // Merged, not replaced: an operator adding one tag to a million objects did
      // not ask to lose whatever else was on them.
      expect(tags.body.tags).toMatchObject({ keep: 'yes', tier: 'cold' });
    } finally {
      client.destroy();
    }
  }, 180_000);

  /* -------------------------------- helpers ------------------------- */

  async function addServer(target: typeof MINIO | typeof SEAWEEDFS): Promise<void> {
    await harness
      .http()
      .post('/api/v1/servers')
      .set(auth())
      .send({
        name: target.name,
        provider: target.provider,
        endpoint: target.endpoint,
        region: target.region,
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
        options: { pathStyle: true, healthIntervalSec: 3600 },
      })
      .expect(201);
  }

  async function createBucket(
    server: string,
    bucket: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    await harness
      .http()
      .post(`/api/v1/servers/${server}/buckets`)
      .set(auth())
      .send({
        name: bucket,
        versioning: false,
        objectLock: false,
        quota: null,
        access: 'private',
        ...overrides,
      })
      .expect(201);
    createdBuckets.push({ server, bucket });
  }

  /** 250 small objects plus 10 larger ones, so a size filter has something to bite. */
  async function seedObjects(): Promise<void> {
    const client = clientFor(MINIO);
    try {
      const small = Buffer.alloc(64, 1);
      const large = Buffer.alloc(8192, 2);
      const puts: Promise<unknown>[] = [];

      for (let index = 0; index < OBJECT_COUNT - 10; index += 1) {
        const key = `data/object-${String(index).padStart(3, '0')}.bin`;
        puts.push(
          client.send(new PutObjectCommand({ Bucket: sourceBucket, Key: key, Body: small })),
        );
        // Bounded parallelism: 260 concurrent PUTs at SeaweedFS's volume allocator
        // is how the dev container ran out of writable volumes once.
        if (puts.length >= 20) {
          await Promise.all(puts.splice(0, puts.length));
        }
      }
      for (let index = 0; index < 10; index += 1) {
        const key = `large/object-${String(index).padStart(2, '0')}.bin`;
        puts.push(
          client.send(new PutObjectCommand({ Bucket: sourceBucket, Key: key, Body: large })),
        );
      }
      await Promise.all(puts);
    } finally {
      client.destroy();
    }
  }

  /** Copies a set of keys to the target bucket outside the engine, for the restart test. */
  async function copyByHand(keys: readonly string[], prefix: string): Promise<void> {
    const source = clientFor(MINIO);
    const target = clientFor(SEAWEEDFS);
    try {
      for (const key of keys) {
        await target.send(
          new PutObjectCommand({ Bucket: targetBucket, Key: `${prefix}${key}`, Body: 'seeded' }),
        );
      }
    } finally {
      source.destroy();
      target.destroy();
    }
  }

  async function createJob(body: Record<string, unknown>): Promise<Job> {
    const response = await harness
      .http()
      .post('/api/v1/jobs')
      .set(auth())
      .send({ params: {}, schedule: { kind: 'now' }, ...body })
      .expect(201);
    return response.body as Job;
  }

  async function fetchJob(id: string): Promise<Job> {
    const response = await harness
      .http()
      .get(`/api/v1/jobs/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as Job;
  }

  async function listKeys(
    target: typeof MINIO | typeof SEAWEEDFS,
    bucket: string,
    prefix: string,
  ): Promise<string[]> {
    const client = clientFor(target);
    const keys: string[] = [];
    let token: string | undefined;
    try {
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix.length > 0 ? prefix : undefined,
            MaxKeys: 1000,
            ContinuationToken: token,
          }),
        );
        for (const entry of response.Contents ?? []) {
          if (entry.Key !== undefined) keys.push(entry.Key);
        }
        token = response.IsTruncated === true ? response.NextContinuationToken : undefined;
      } while (token !== undefined);
    } finally {
      client.destroy();
    }
    return keys;
  }

  async function listVersions(
    target: typeof MINIO | typeof SEAWEEDFS,
    bucket: string,
  ): Promise<{ versions: number; markers: number }> {
    const client = clientFor(target);
    try {
      const response = await client.send(new ListObjectVersionsCommand({ Bucket: bucket }));
      return {
        versions: (response.Versions ?? []).length,
        markers: (response.DeleteMarkers ?? []).length,
      };
    } finally {
      client.destroy();
    }
  }

  async function forceCleanup(server: string, bucket: string): Promise<void> {
    const target = server === MINIO.name ? MINIO : SEAWEEDFS;
    const client = clientFor(target);
    try {
      const listed = await client.send(new ListObjectVersionsCommand({ Bucket: bucket }));
      const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
        .filter((entry) => entry.Key !== undefined)
        .map((entry) => ({ Key: entry.Key as string, VersionId: entry.VersionId }));
      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
        );
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    } catch {
      // Best effort: every bucket is named after this run, so debris cannot break
      // the next one, and throwing here would hide the real failure.
    } finally {
      client.destroy();
    }
  }

  function clientFor(target: typeof MINIO | typeof SEAWEEDFS): S3Client {
    return new S3Client({
      endpoint: target.endpoint,
      region: target.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
      },
    });
  }
});
