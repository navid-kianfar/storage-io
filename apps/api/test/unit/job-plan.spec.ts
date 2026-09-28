import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_START,
  parseCheckpoint,
  planSegments,
  serializeCheckpoint,
  type JobSegment,
} from '../../src/modules/jobs/job-engine.service';

/**
 * The two things a run needs to be exact: what it has to walk, and where it
 * stopped. Both are pure functions so they can be proved without a storage
 * server, and both used to be wrong in a way that only showed up on real data —
 * a selection of three folders where only the first was touched, and a pause
 * mid-page that skipped the rest of it on resume.
 */

const prefixes = (plan: readonly JobSegment[]): readonly string[] =>
  plan.filter((segment) => segment.kind === 'prefix').map((segment) => segment.prefix);

const keysOf = (plan: readonly JobSegment[]): readonly string[] =>
  plan.flatMap((segment) => (segment.kind === 'keys' ? [...segment.keys] : []));

describe('planSegments', () => {
  it('walks every selected prefix, not just the first', () => {
    const plan = planSegments(null, ['p1/', 'p2/', 'p3/'], '');
    expect(prefixes(plan)).toEqual(['p1/', 'p2/', 'p3/']);
  });

  it("covers the reviewer's repro: a loose key plus two folders", () => {
    const plan = planSegments(['loose.txt'], ['p1/', 'p2/'], '');
    expect(keysOf(plan)).toEqual(['loose.txt']);
    expect(prefixes(plan)).toEqual(['p1/', 'p2/']);
  });

  it('drops a prefix that another prefix already contains', () => {
    const plan = planSegments(null, ['p1/', 'p1/sub/', 'p2/'], '');
    expect(prefixes(plan)).toEqual(['p1/', 'p2/']);
  });

  it('drops an explicit key that falls under a selected prefix', () => {
    const plan = planSegments(['p1/a.txt', 'loose.txt'], ['p1/'], '');
    expect(keysOf(plan)).toEqual(['loose.txt']);
  });

  it('removes duplicates in both lists', () => {
    const plan = planSegments(['a.txt', 'a.txt'], ['p1/', 'p1/'], '');
    expect(keysOf(plan)).toEqual(['a.txt']);
    expect(prefixes(plan)).toEqual(['p1/']);
  });

  it('is the filter listing when nothing was selected', () => {
    expect(planSegments(null, [], 'reports/')).toEqual([{ kind: 'prefix', prefix: 'reports/' }]);
    expect(planSegments(null, [], '')).toEqual([{ kind: 'prefix', prefix: '' }]);
  });

  it('falls back to the filter listing when a selection reduced to nothing', () => {
    expect(planSegments([], [], 'x/')).toEqual([{ kind: 'prefix', prefix: 'x/' }]);
  });

  it('keeps keys before prefixes, so a selection is done in the order it reads', () => {
    const plan = planSegments(['a.txt'], ['p1/'], '');
    expect(plan[0]?.kind).toBe('keys');
    expect(plan[1]?.kind).toBe('prefix');
  });
});

describe('the run checkpoint', () => {
  it('round-trips', () => {
    const checkpoint = { segment: 2, token: 'abc/def', cursor: 137 };
    expect(parseCheckpoint(serializeCheckpoint(checkpoint))).toEqual(checkpoint);
  });

  it('starts at the beginning when there is nothing stored', () => {
    expect(parseCheckpoint(null)).toEqual(CHECKPOINT_START);
    expect(parseCheckpoint('')).toEqual(CHECKPOINT_START);
  });

  it('reads a checkpoint written in the old bare-token format', () => {
    // A job that was mid-run when the process was upgraded: the old column held
    // the continuation token and nothing else, which is segment 0 at that page.
    expect(parseCheckpoint('some-s3-continuation-token')).toEqual({
      segment: 0,
      token: 'some-s3-continuation-token',
      cursor: 0,
    });
  });

  it('reads an old key-page offset, which is a number that is not a checkpoint', () => {
    expect(parseCheckpoint('1000')).toEqual({ segment: 0, token: '1000', cursor: 0 });
  });

  it('keeps a null token, which is the start of a segment', () => {
    expect(parseCheckpoint(serializeCheckpoint({ segment: 1, token: null, cursor: 0 }))).toEqual({
      segment: 1,
      token: null,
      cursor: 0,
    });
  });
});
