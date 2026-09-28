import { CronTime } from 'cron';
import { ValidationError } from '../../common/errors/domain.exception';

/**
 * Cron expressions for recurring jobs: validation and the next run.
 *
 * `cron`'s `CronTime` does the parsing and the timezone arithmetic (it is the
 * same class `@nestjs/schedule` uses, and it resolves zones through luxon, so a
 * DST transition lands on the right wall-clock time rather than drifting by an
 * hour twice a year). Writing that by hand is where a scheduler quietly fires
 * twice on the last Sunday in October.
 *
 * **Five fields only.** `CronTime` also accepts a six-field expression whose
 * first field is seconds, which would let an operator schedule a bucket-wide copy
 * every second. The extra field is rejected with a sentence rather than silently
 * accepted, because "0 3 * * * *" looks like a daily job and is not one.
 *
 * Verified against `cron@4.4.0`: `getNextDateFrom(date, timezone)` returns a
 * luxon `DateTime` in that zone, an unparseable expression throws at
 * construction, and an unknown zone throws `Invalid timezone.`.
 */

const CRON_FIELD_COUNT = 5;

export interface CronValidity {
  readonly ok: boolean;
  /** Safe to show an operator; no library internals. */
  readonly detail: string;
}

/** Splits on any run of whitespace, ignoring leading and trailing space. */
const fieldsOf = (expression: string): readonly string[] =>
  expression
    .trim()
    .split(/\s+/)
    .filter((field) => field.length > 0);

export function checkCron(expression: string, timezone: string): CronValidity {
  const fields = fieldsOf(expression);
  if (fields.length !== CRON_FIELD_COUNT) {
    return {
      ok: false,
      detail: `A cron expression needs ${CRON_FIELD_COUNT} fields (minute hour day month weekday); this one has ${fields.length}.`,
    };
  }

  try {
    const time = new CronTime(fields.join(' '), timezone);
    time.getNextDateFrom(new Date(), timezone);
    return { ok: true, detail: 'ok' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `That cron expression or timezone is not valid: ${message}` };
  }
}

/** Throws `VALIDATION` with the reason, for the create and update paths. */
export function assertCron(expression: string, timezone: string): void {
  const validity = checkCron(expression, timezone);
  if (validity.ok) return;
  throw new ValidationError(validity.detail);
}

/**
 * The next fire time strictly after `after`, as an ISO string. `null` when the
 * expression or zone is invalid — the caller has already validated at the edge,
 * so reaching null here means a row written by an older version, and a schedule
 * that cannot be computed must not take the scheduler down.
 */
export function nextRunAfter(
  expression: string,
  timezone: string,
  after: Date = new Date(),
): string | null {
  try {
    const time = new CronTime(expression.trim(), timezone);
    const next = time.getNextDateFrom(after, timezone);
    return next.toUTC().toISO();
  } catch {
    return null;
  }
}
