/**
 * A cron expression, in words.
 *
 * The concept puts "Every day at 03:00" under `0 3 * * *`, which is the whole
 * point of the column: an operator should not have to parse five fields to see
 * whether a destructive job runs nightly or hourly. This recognises the shapes a
 * schedule is actually written in and returns a *description*, not a sentence —
 * the component translates it, so the wording lives in the locale files like
 * every other string.
 *
 * Anything it does not recognise returns `null`, and the caller shows the raw
 * expression rather than a guess. A wrong description of a delete schedule is
 * worse than no description.
 */

export const CRON_FIELD_COUNT = 5;

export type CronDescription =
  | { readonly kind: 'everyMinute' }
  | { readonly kind: 'everyNMinutes'; readonly minutes: number }
  | { readonly kind: 'hourly'; readonly minute: number }
  | { readonly kind: 'everyNHours'; readonly hours: number; readonly minute: number }
  | { readonly kind: 'daily'; readonly time: string }
  | { readonly kind: 'weekly'; readonly weekday: number; readonly time: string }
  | { readonly kind: 'weekdays'; readonly time: string }
  | { readonly kind: 'monthly'; readonly day: number; readonly time: string };

const WEEKDAY_NAME_TO_NUMBER: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MINUTES_IN_HOUR = 60;
const HOURS_IN_DAY = 24;
const DAYS_IN_WEEK = 7;
const TIME_PAD = 2;

export interface CronFields {
  readonly minute: string;
  readonly hour: string;
  readonly dayOfMonth: string;
  readonly month: string;
  readonly dayOfWeek: string;
}

export function parseCronFields(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== CRON_FIELD_COUNT) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    return null;
  }
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/** True when the expression is five fields of characters cron understands. */
export function isCronExpression(expression: string): boolean {
  const fields = parseCronFields(expression);
  if (fields === null) return false;
  const allowed = /^[\d*,/\-A-Za-z?]+$/;
  return [fields.minute, fields.hour, fields.dayOfMonth, fields.month, fields.dayOfWeek].every(
    (field) => allowed.test(field),
  );
}

function asFixedNumber(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

function asStep(field: string, max: number): number | null {
  const match = /^\*\/(\d+)$/.exec(field);
  if (match === null) return null;
  const step = Number(match[1]);
  return step >= 1 && step < max ? step : null;
}

function asWeekday(field: string): number | null {
  const numeric = asFixedNumber(field, 0, DAYS_IN_WEEK);
  if (numeric !== null) return numeric % DAYS_IN_WEEK;
  const named = WEEKDAY_NAME_TO_NUMBER[field.toLowerCase()];
  return named ?? null;
}

function timeOf(hour: number, minute: number): string {
  return `${String(hour).padStart(TIME_PAD, '0')}:${String(minute).padStart(TIME_PAD, '0')}`;
}

const WEEKDAY_FIELD_PATTERN = /^(1-5|mon-fri|MON-FRI)$/;

export function describeCron(expression: string): CronDescription | null {
  const fields = parseCronFields(expression);
  if (fields === null) return null;

  const { minute, hour, dayOfMonth, month, dayOfWeek } = fields;
  // Anything month-specific is beyond what one sentence can say honestly.
  if (month !== '*') return null;

  const everyDayOfMonth = dayOfMonth === '*' || dayOfMonth === '?';
  const everyDayOfWeek = dayOfWeek === '*' || dayOfWeek === '?';

  if (minute === '*' && hour === '*' && everyDayOfMonth && everyDayOfWeek) {
    return { kind: 'everyMinute' };
  }

  const minuteStep = asStep(minute, MINUTES_IN_HOUR);
  if (minuteStep !== null && hour === '*' && everyDayOfMonth && everyDayOfWeek) {
    return { kind: 'everyNMinutes', minutes: minuteStep };
  }

  const fixedMinute = asFixedNumber(minute, 0, MINUTES_IN_HOUR - 1);
  if (fixedMinute === null) return null;

  if (hour === '*' && everyDayOfMonth && everyDayOfWeek) {
    return { kind: 'hourly', minute: fixedMinute };
  }

  const hourStep = asStep(hour, HOURS_IN_DAY);
  if (hourStep !== null && everyDayOfMonth && everyDayOfWeek) {
    return { kind: 'everyNHours', hours: hourStep, minute: fixedMinute };
  }

  const fixedHour = asFixedNumber(hour, 0, HOURS_IN_DAY - 1);
  if (fixedHour === null) return null;
  const time = timeOf(fixedHour, fixedMinute);

  if (everyDayOfMonth && everyDayOfWeek) return { kind: 'daily', time };

  if (everyDayOfMonth && WEEKDAY_FIELD_PATTERN.test(dayOfWeek)) {
    return { kind: 'weekdays', time };
  }

  if (everyDayOfMonth) {
    const weekday = asWeekday(dayOfWeek);
    if (weekday === null) return null;
    return { kind: 'weekly', weekday, time };
  }

  if (everyDayOfWeek) {
    const day = asFixedNumber(dayOfMonth, 1, 31);
    if (day === null) return null;
    return { kind: 'monthly', day, time };
  }

  return null;
}

/** Long weekday names in the operator's own locale, so "Sunday" is not hard-coded. */
export function weekdayName(weekday: number, locale: string): string {
  // 2026-01-04 was a Sunday, so adding the index lands on the right day whatever
  // the month's length — no date arithmetic across a boundary.
  const sundayUtc = Date.UTC(2026, 0, 4 + (weekday % DAYS_IN_WEEK));
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(sundayUtc),
  );
}

/** The presets the schedule step offers, in the order the concept lists them. */
export const CRON_PRESETS = [
  '0 * * * *',
  '0 3 * * *',
  '0 4 * * 0',
  '0 2 1 * *',
  '*/15 * * * *',
] as const;
