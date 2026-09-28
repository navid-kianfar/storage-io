import { describe, expect, it } from 'vitest';
import { assertCron, checkCron, nextRunAfter } from '../../src/modules/jobs/cron';
import { ValidationError } from '../../src/common/errors/domain.exception';

/**
 * The scheduler's arithmetic. It is worth a test of its own because every bug here
 * is invisible until the wrong night: a job that fires twice across a DST
 * transition, or one that stops firing because a five-field expression was read as
 * six.
 */
describe('cron next-run', () => {
  it('returns the next matching minute, strictly after the given instant', () => {
    const next = nextRunAfter('*/5 * * * *', 'UTC', new Date('2026-01-01T00:02:00Z'));
    expect(next).toBe('2026-01-01T00:05:00.000Z');
  });

  it('does not return the instant it was given even when it matches', () => {
    // Otherwise a schedule due at 03:00 would fire, recompute "next" as 03:00, and
    // fire again on the next tick.
    const next = nextRunAfter('0 3 * * *', 'UTC', new Date('2026-03-10T03:00:00Z'));
    expect(next).toBe('2026-03-11T03:00:00.000Z');
  });

  it('resolves the wall-clock time in the job’s own timezone', () => {
    // 03:00 in Tehran (+03:30) is 23:30 UTC the day before.
    const next = nextRunAfter('0 3 * * *', 'Asia/Tehran', new Date('2026-06-01T00:00:00Z'));
    expect(next).toBe('2026-06-01T23:30:00.000Z');
  });

  it('keeps the wall-clock hour across a DST transition', () => {
    // Europe/Berlin springs forward on 2026-03-29: 02:00 → 03:00 local. A daily
    // 04:00 job is 03:00 UTC before the change and 02:00 UTC after it — the same
    // local time, which is what the operator asked for.
    const before = nextRunAfter('0 4 * * *', 'Europe/Berlin', new Date('2026-03-27T12:00:00Z'));
    const after = nextRunAfter('0 4 * * *', 'Europe/Berlin', new Date('2026-03-30T12:00:00Z'));
    expect(before).toBe('2026-03-28T03:00:00.000Z');
    expect(after).toBe('2026-03-31T02:00:00.000Z');
  });

  it('handles day-of-week and month fields', () => {
    // Every Monday at 02:30. 2026-01-01 is a Thursday, so the next is the 5th.
    const next = nextRunAfter('30 2 * * 1', 'UTC', new Date('2026-01-01T00:00:00Z'));
    expect(next).toBe('2026-01-05T02:30:00.000Z');
  });

  it('returns null for an expression it cannot read, rather than throwing', () => {
    // The scheduler walks every due row; one unreadable expression must not take
    // the tick down with it.
    expect(nextRunAfter('not a cron', 'UTC')).toBeNull();
    expect(nextRunAfter('*/5 * * * *', 'Mars/Olympus')).toBeNull();
  });
});

describe('cron validation', () => {
  it('accepts a five-field expression with a real timezone', () => {
    expect(checkCron('0 3 * * *', 'Europe/Berlin')).toEqual({ ok: true, detail: 'ok' });
  });

  it('rejects a six-field expression and says why', () => {
    // `cron` would read the first field as seconds, so "0 3 * * * *" looks daily
    // and would in fact run every minute at second 0.
    const result = checkCron('0 0 3 * * *', 'UTC');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('5 fields');
  });

  it('rejects too few fields', () => {
    expect(checkCron('0 3 *', 'UTC').ok).toBe(false);
  });

  it('rejects an unparseable expression and an unknown timezone', () => {
    expect(checkCron('bananas * * * *', 'UTC').ok).toBe(false);
    expect(checkCron('0 3 * * *', 'Mars/Olympus').ok).toBe(false);
  });

  it('is insensitive to surrounding and repeated whitespace', () => {
    expect(checkCron('  0   3  *  *  * ', 'UTC').ok).toBe(true);
  });

  it('assertCron raises a VALIDATION error carrying the reason', () => {
    expect(() => assertCron('0 3 * * *', 'UTC')).not.toThrow();
    try {
      assertCron('0 0 3 * * *', 'UTC');
      expect.unreachable('assertCron should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe('VALIDATION');
    }
  });
});
