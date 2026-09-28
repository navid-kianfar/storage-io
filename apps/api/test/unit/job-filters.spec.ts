import { describe, expect, it } from 'vitest';
import { JOB_FILTER_DEFAULTS, type JobFilters } from '@storage-io/contracts';
import {
  compileFilters,
  matchesListingFilters,
  matchesTagFilter,
  needsTags,
  type JobCandidate,
} from '../../src/modules/jobs/job-filters';

/**
 * The code that decides which objects a job touches. It is tested without a
 * storage server because that is the point: an operator's "delete everything over
 * 1 GB modified before March" has to be provably right before it is pointed at a
 * bucket.
 */

const filters = (overrides: Partial<JobFilters> = {}): JobFilters => ({
  ...JOB_FILTER_DEFAULTS,
  ...overrides,
});

const object = (overrides: Partial<JobCandidate> = {}): JobCandidate => ({
  key: 'logs/app.log',
  size: 1024,
  lastModified: '2026-03-15T00:00:00.000Z',
  ...overrides,
});

describe('job filters', () => {
  it('matches everything with the defaults', () => {
    const compiled = compileFilters(filters());
    expect(matchesListingFilters(compiled, object())).toBe(true);
    expect(matchesListingFilters(compiled, object({ key: 'anything', size: 0 }))).toBe(true);
  });

  describe('prefix', () => {
    it('keeps only keys under it', () => {
      const compiled = compileFilters(filters({ prefix: 'logs/' }));
      expect(matchesListingFilters(compiled, object({ key: 'logs/app.log' }))).toBe(true);
      expect(matchesListingFilters(compiled, object({ key: 'images/a.png' }))).toBe(false);
    });

    it('is a prefix, not a path segment', () => {
      // `logs` matches `logs-old/…` too; S3 prefixes work that way and the job must
      // behave like the listing it is built on.
      const compiled = compileFilters(filters({ prefix: 'logs' }));
      expect(matchesListingFilters(compiled, object({ key: 'logs-old/a.log' }))).toBe(true);
    });
  });

  describe('size range', () => {
    it('is inclusive at both ends', () => {
      const compiled = compileFilters(filters({ minSize: 100, maxSize: 200 }));
      expect(matchesListingFilters(compiled, object({ size: 100 }))).toBe(true);
      expect(matchesListingFilters(compiled, object({ size: 200 }))).toBe(true);
      expect(matchesListingFilters(compiled, object({ size: 99 }))).toBe(false);
      expect(matchesListingFilters(compiled, object({ size: 201 }))).toBe(false);
    });

    it('accepts a zero-byte object when minSize is 0', () => {
      const compiled = compileFilters(filters({ minSize: 0 }));
      expect(matchesListingFilters(compiled, object({ size: 0 }))).toBe(true);
    });
  });

  describe('modified window', () => {
    it('is inclusive at both ends', () => {
      const compiled = compileFilters(
        filters({
          modifiedAfter: '2026-03-01T00:00:00.000Z',
          modifiedBefore: '2026-03-31T00:00:00.000Z',
        }),
      );
      expect(
        matchesListingFilters(compiled, object({ lastModified: '2026-03-01T00:00:00.000Z' })),
      ).toBe(true);
      expect(
        matchesListingFilters(compiled, object({ lastModified: '2026-03-31T00:00:00.000Z' })),
      ).toBe(true);
      expect(
        matchesListingFilters(compiled, object({ lastModified: '2026-02-28T23:59:59.000Z' })),
      ).toBe(false);
      expect(
        matchesListingFilters(compiled, object({ lastModified: '2026-04-01T00:00:00.000Z' })),
      ).toBe(false);
    });

    it('excludes an object whose last-modified is unknown', () => {
      // Including it would be the silent wrong answer on a delete job.
      const compiled = compileFilters(filters({ modifiedBefore: '2026-03-31T00:00:00.000Z' }));
      expect(matchesListingFilters(compiled, object({ lastModified: null }))).toBe(false);
    });

    it('ignores a date filter that cannot be parsed rather than excluding everything', () => {
      const compiled = compileFilters(filters({ modifiedAfter: 'not a date' }));
      expect(compiled.modifiedAfterMs).toBeNull();
      expect(matchesListingFilters(compiled, object())).toBe(true);
    });
  });

  describe('glob', () => {
    it('matches the whole key, and `*` crosses slashes', () => {
      const compiled = compileFilters(filters({ glob: '*.log' }));
      expect(matchesListingFilters(compiled, object({ key: 'logs/app.log' }))).toBe(true);
      expect(matchesListingFilters(compiled, object({ key: 'logs/app.txt' }))).toBe(false);
    });

    it('supports alternation and character classes', () => {
      const compiled = compileFilters(filters({ glob: 'backup/{db,files}-20[12][0-9].tar.gz' }));
      expect(matchesListingFilters(compiled, object({ key: 'backup/db-2026.tar.gz' }))).toBe(true);
      expect(matchesListingFilters(compiled, object({ key: 'backup/files-2019.tar.gz' }))).toBe(
        true,
      );
      expect(matchesListingFilters(compiled, object({ key: 'backup/logs-2026.tar.gz' }))).toBe(
        false,
      );
    });

    it('is case sensitive, because S3 keys are', () => {
      const compiled = compileFilters(filters({ glob: '*.LOG' }));
      expect(matchesListingFilters(compiled, object({ key: 'a.log' }))).toBe(false);
    });

    it('treats an empty glob as no filter', () => {
      expect(compileFilters(filters({ glob: '' })).glob).toBeNull();
    });
  });

  describe('tags', () => {
    it('needsTags is false unless a tag filter is set — no GetObjectTagging otherwise', () => {
      expect(needsTags(compileFilters(filters()))).toBe(false);
      expect(needsTags(compileFilters(filters({ tags: { env: 'prod' } })))).toBe(true);
    });

    it('requires every named tag to match exactly', () => {
      const compiled = compileFilters(filters({ tags: { env: 'prod', tier: 'cold' } }));
      expect(matchesTagFilter(compiled, { env: 'prod', tier: 'cold', extra: 'x' })).toBe(true);
      expect(matchesTagFilter(compiled, { env: 'prod' })).toBe(false);
      expect(matchesTagFilter(compiled, { env: 'Prod', tier: 'cold' })).toBe(false);
      expect(matchesTagFilter(compiled, {})).toBe(false);
    });

    it('matches anything when no tag filter is set', () => {
      expect(matchesTagFilter(compileFilters(filters()), {})).toBe(true);
    });
  });

  it('applies every filter together, not the first one that matches', () => {
    const compiled = compileFilters(
      filters({
        prefix: 'logs/',
        glob: '*.log',
        minSize: 500,
        modifiedBefore: '2026-04-01T00:00:00.000Z',
      }),
    );
    expect(matchesListingFilters(compiled, object())).toBe(true);
    // Right prefix, right glob, right date — but too small.
    expect(matchesListingFilters(compiled, object({ size: 10 }))).toBe(false);
  });
});
