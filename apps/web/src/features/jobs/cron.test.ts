import { describe, expect, it } from 'vitest';
import { describeCron, isCronExpression, parseCronFields, weekdayName } from './cron';

/**
 * The cron reader is the only place in the app that turns an operator's input into
 * a sentence about when a destructive job runs, so the cases that matter are the
 * ones where it must *refuse* to describe rather than guess.
 */

describe('parseCronFields', () => {
  it('needs exactly five fields', () => {
    expect(parseCronFields('0 3 * * *')).not.toBeNull();
    expect(parseCronFields('0 3 * *')).toBeNull();
    expect(parseCronFields('0 3 * * * *')).toBeNull();
  });

  it('collapses runs of whitespace', () => {
    expect(parseCronFields('  0   3 *  * * ')).toEqual({
      minute: '0',
      hour: '3',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '*',
    });
  });
});

describe('isCronExpression', () => {
  it('accepts the shapes cron actually uses', () => {
    expect(isCronExpression('0 3 * * *')).toBe(true);
    expect(isCronExpression('*/15 * * * *')).toBe(true);
    expect(isCronExpression('0 4 * * MON-FRI')).toBe(true);
  });

  it('rejects anything that is not five cron fields', () => {
    expect(isCronExpression('every day at 3')).toBe(false);
    expect(isCronExpression('0 3 * *')).toBe(false);
    expect(isCronExpression('0 3 * * !')).toBe(false);
  });
});

describe('describeCron', () => {
  it('describes the presets the wizard offers', () => {
    expect(describeCron('0 * * * *')).toEqual({ kind: 'hourly', minute: 0 });
    expect(describeCron('0 3 * * *')).toEqual({ kind: 'daily', time: '03:00' });
    expect(describeCron('0 4 * * 0')).toEqual({ kind: 'weekly', weekday: 0, time: '04:00' });
    expect(describeCron('0 2 1 * *')).toEqual({ kind: 'monthly', day: 1, time: '02:00' });
    expect(describeCron('*/15 * * * *')).toEqual({ kind: 'everyNMinutes', minutes: 15 });
  });

  it('pads the time so 03:05 never reads as 3:5', () => {
    expect(describeCron('5 3 * * *')).toEqual({ kind: 'daily', time: '03:05' });
  });

  it('reads named and numeric weekdays the same way', () => {
    expect(describeCron('30 6 * * SUN')).toEqual({ kind: 'weekly', weekday: 0, time: '06:30' });
    // Cron accepts 7 for Sunday as well as 0.
    expect(describeCron('30 6 * * 7')).toEqual({ kind: 'weekly', weekday: 0, time: '06:30' });
  });

  it('recognises the weekday range', () => {
    expect(describeCron('0 9 * * 1-5')).toEqual({ kind: 'weekdays', time: '09:00' });
  });

  it('returns null rather than guessing at an expression it does not model', () => {
    // A month restriction, a list of hours, and a day-of-month *and* day-of-week
    // combination all mean something this cannot say in one sentence.
    expect(describeCron('0 3 * 6 *')).toBeNull();
    expect(describeCron('0 3,15 * * *')).toBeNull();
    expect(describeCron('0 3 1 * 1')).toBeNull();
    expect(describeCron('not a cron')).toBeNull();
  });

  it('rejects out-of-range fields instead of describing them', () => {
    expect(describeCron('0 25 * * *')).toBeNull();
    expect(describeCron('60 3 * * *')).toBeNull();
  });
});

describe('weekdayName', () => {
  it('names the weekday in the given locale', () => {
    expect(weekdayName(0, 'en-US')).toBe('Sunday');
    expect(weekdayName(1, 'en-US')).toBe('Monday');
    expect(weekdayName(6, 'en-US')).toBe('Saturday');
  });
});
