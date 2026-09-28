import { describe, expect, it } from 'vitest';
import { JOB_PROGRESS_ZERO, type Job, type JobProgress } from '@storage-io/contracts';
import {
  clampConcurrency,
  outcomeFor,
  runWithPool,
  versionsNeededFor,
} from '../../src/modules/jobs/job-engine.service';
import { copySource, withSuffix } from '../../src/modules/jobs/job-actions.service';
import { joinVersionToken, splitVersionToken } from '../../src/modules/jobs/job-source.service';

/**
 * The engine's decisions, separated from the engine so they can be proved without
 * a storage server: the object pool's pacing, how a run's outcome is named, and the
 * three small encodings a resume depends on.
 */

const progress = (overrides: Partial<JobProgress> = {}): JobProgress => ({
  ...JOB_PROGRESS_ZERO,
  ...overrides,
});

describe('runWithPool', () => {
  it('runs every item exactly once', async () => {
    const items = Array.from({ length: 50 }, (_, index) => index);
    const seen: number[] = [];
    await runWithPool(
      items,
      () => 4,
      async (item) => {
        await Promise.resolve();
        seen.push(item);
      },
      () => false,
    );
    expect(seen).toHaveLength(50);
    expect([...seen].sort((left, right) => left - right)).toEqual(items);
  });

  it('never exceeds the limit it is given', async () => {
    let active = 0;
    let peak = 0;
    await runWithPool(
      Array.from({ length: 40 }, (_, index) => index),
      () => 5,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      },
      () => false,
    );
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it('picks up a raised limit as soon as a worker frees up', async () => {
    let limit = 1;
    let active = 0;
    let peak = 0;
    let done = 0;

    await runWithPool(
      Array.from({ length: 30 }, (_, index) => index),
      () => limit,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        done += 1;
        // The operator moves the slider a third of the way through.
        if (done === 10) limit = 6;
        active -= 1;
      },
      () => false,
    );

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it('stops scheduling when asked, and waits for what is in flight', async () => {
    let stop = false;
    let started = 0;
    let finished = 0;

    await runWithPool(
      Array.from({ length: 100 }, (_, index) => index),
      () => 2,
      async () => {
        started += 1;
        if (started === 4) stop = true;
        await new Promise((resolve) => setTimeout(resolve, 1));
        finished += 1;
      },
      () => stop,
    );

    // It stopped early, and nothing was abandoned mid-flight.
    expect(started).toBeLessThan(100);
    expect(finished).toBe(started);
  });

  it('treats a limit below one as one rather than deadlocking', async () => {
    let count = 0;
    await runWithPool(
      [1, 2, 3],
      () => 0,
      async () => {
        await Promise.resolve();
        count += 1;
      },
      () => false,
    );
    expect(count).toBe(3);
  });

  it('resolves immediately on an empty page', async () => {
    await expect(
      runWithPool(
        [],
        () => 4,
        async () => {
          await Promise.resolve();
        },
        () => false,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('outcomeFor', () => {
  it('is completed only when nothing failed', () => {
    expect(outcomeFor(progress({ processed: 10 }))).toBe('completed');
    expect(outcomeFor(progress({ processed: 0, skipped: 10 }))).toBe('completed');
  });

  it('is failed when nothing at all succeeded', () => {
    expect(outcomeFor(progress({ processed: 0, failed: 10 }))).toBe('failed');
  });

  it('is completed_with_errors for a partial success', () => {
    expect(outcomeFor(progress({ processed: 9, failed: 1 }))).toBe('completed_with_errors');
  });
});

describe('clampConcurrency', () => {
  it('holds the contract bounds and truncates', () => {
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(-5)).toBe(1);
    expect(clampConcurrency(8.7)).toBe(8);
    expect(clampConcurrency(64)).toBe(64);
    expect(clampConcurrency(1000)).toBe(64);
  });
});

describe('versionsNeededFor', () => {
  const job = (type: Job['type'], includeVersions?: boolean): Job =>
    ({ type, params: includeVersions === undefined ? {} : { includeVersions } }) as Job;

  it('always walks versions for empty-bucket and restore-versions', () => {
    // Deleting only current versions leaves a versioned bucket full; a delete
    // marker is the only thing a restore acts on.
    expect(versionsNeededFor(job('empty-bucket'))).toBe(true);
    expect(versionsNeededFor(job('restore-versions'))).toBe(true);
    expect(versionsNeededFor(job('empty-bucket', false))).toBe(true);
  });

  it('follows params.includeVersions for everything else', () => {
    expect(versionsNeededFor(job('delete'))).toBe(false);
    expect(versionsNeededFor(job('delete', true))).toBe(true);
    expect(versionsNeededFor(job('copy', true))).toBe(true);
  });
});

describe('copySource', () => {
  it('encodes each key segment but keeps the slashes', () => {
    expect(copySource('photos', 'holiday/a b.jpg')).toBe('photos/holiday/a%20b.jpg');
  });

  it('appends an encoded version id when one is given', () => {
    expect(copySource('photos', 'a.jpg', 'v/1')).toBe('photos/a.jpg?versionId=v%2F1');
  });
});

describe('withSuffix', () => {
  it('inserts the counter before the extension', () => {
    expect(withSuffix('photo.jpg', 2)).toBe('photo (2).jpg');
    expect(withSuffix('dir/photo.tar.gz', 3)).toBe('dir/photo.tar (3).gz');
  });

  it('appends when there is no extension', () => {
    expect(withSuffix('README', 2)).toBe('README (2)');
    expect(withSuffix('dir/README', 2)).toBe('dir/README (2)');
  });

  it('does not treat a leading dot as an extension', () => {
    expect(withSuffix('.env', 2)).toBe('.env (2)');
  });
});

describe('versioned continuation token', () => {
  it('round-trips both markers', () => {
    const token = joinVersionToken('key-marker', 'version-marker');
    expect(splitVersionToken(token)).toEqual(['key-marker', 'version-marker']);
  });

  it('round-trips a key marker with no version marker', () => {
    const token = joinVersionToken('key-marker', undefined);
    expect(splitVersionToken(token)).toEqual(['key-marker', undefined]);
  });

  it('is null when there is nothing to continue from', () => {
    expect(joinVersionToken(undefined, undefined)).toBeNull();
    expect(splitVersionToken(null)).toEqual([undefined, undefined]);
  });

  it('survives a key marker containing a slash or a space', () => {
    const token = joinVersionToken('a/b c.txt', 'v1');
    expect(splitVersionToken(token)).toEqual(['a/b c.txt', 'v1']);
  });
});
