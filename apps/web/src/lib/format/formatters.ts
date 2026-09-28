import type { RegionSettings } from '@storage-io/contracts';
import type { Language } from '@/stores/preferences';

/**
 * Every number, size, percentage, duration and date in the app goes through one
 * of these. They are pure functions of (locale, region settings, value), which is
 * what lets the tests assert output without a React tree.
 *
 * The concept's rules, kept verbatim:
 * - Sizes use `Intl.NumberFormat` with a `unit` style, so Persian gets Persian
 *   digits and the right unit word for free.
 * - Percentages, counts and durations are `Intl`, never string concatenation.
 * - A relative time is `Intl.RelativeTimeFormat` with `numeric: 'auto'`.
 */

const DECIMAL_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte', 'petabyte'] as const;
/** `Intl` has no binary units, so the suffix is spelled out for KiB..PiB. */
const BINARY_SUFFIXES = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

const DECIMAL_STEP = 1000;
const BINARY_STEP = 1024;
const MAX_UNIT_INDEX = DECIMAL_UNITS.length - 1;
/** Below this many units, one decimal reads better: "1.2 TB" not "1 TB". */
const ONE_DECIMAL_BELOW = 100;

const SECOND = 1;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const MS_IN_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_IN_SECOND;

export interface FormatOptions {
  readonly locale: string;
  readonly region: RegionSettings;
}

/**
 * The BCP-47 tag actually handed to `Intl`: the UI language plus the calendar and
 * numbering-system overrides from Settings. `calendar: 'auto'` means "whatever the
 * locale does", which is Solar Hijri for `fa` and Gregorian for `en`.
 */
export function intlLocale(language: Language, region: RegionSettings): string {
  const extensions: string[] = [];
  if (region.calendar !== 'auto') extensions.push(`ca-${region.calendar}`);
  if (region.digits === 'latn') extensions.push('nu-latn');
  return extensions.length === 0 ? language : `${language}-u-${extensions.join('-')}`;
}

export function formatNumber(
  value: number,
  { locale }: FormatOptions,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, ...options }).format(value);
}

/** Compact notation for counts that can reach millions: "48M objects". */
export function formatCompact(value: number, options: FormatOptions): string {
  return formatNumber(value, options, { notation: 'compact', maximumFractionDigits: 1 });
}

export function formatPercent(ratio: number, options: FormatOptions, fractionDigits = 0): string {
  return formatNumber(ratio, options, {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * A byte count. `sizeUnits: 'decimal'` (the default) gives TB/GB via `Intl` units;
 * `'binary'` gives TiB/GiB, where `Intl` has no unit so the number is localised
 * and the suffix appended.
 */
export function formatBytes(value: number, options: FormatOptions): string {
  const { locale, region } = options;
  const binary = region.sizeUnits === 'binary';
  const step = binary ? BINARY_STEP : DECIMAL_STEP;

  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);

  const index =
    magnitude < step
      ? 0
      : Math.min(MAX_UNIT_INDEX, Math.floor(Math.log(magnitude) / Math.log(step)));
  const scaled = sign * (magnitude / step ** index);
  const maximumFractionDigits = index > 0 && Math.abs(scaled) < ONE_DECIMAL_BELOW ? 1 : 0;

  // Below one kilobyte Intl's `byte` unit spells the word out ("374 byte"),
  // unlike every larger unit ("2.5 MB"); use the same "B" suffix both systems share.
  if (binary || index === 0) {
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits }).format(scaled);
    if (index === 0) return `${number} B`;
    return `${number} ${BINARY_SUFFIXES[index] ?? BINARY_SUFFIXES[MAX_UNIT_INDEX]}`;
  }

  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: DECIMAL_UNITS[index] ?? DECIMAL_UNITS[MAX_UNIT_INDEX],
    unitDisplay: 'short',
    maximumFractionDigits,
  }).format(scaled);
}

/** A latency or a duration in milliseconds: "12 ms", "1.4 s", "2 min". */
export function formatMilliseconds(value: number, options: FormatOptions): string {
  if (!Number.isFinite(value)) return '—';
  if (value < MS_IN_SECOND) {
    return formatNumber(value, options, {
      style: 'unit',
      unit: 'millisecond',
      unitDisplay: 'narrow',
      maximumFractionDigits: 0,
    });
  }
  if (value < MS_PER_MINUTE) {
    return formatNumber(value / MS_IN_SECOND, options, {
      style: 'unit',
      unit: 'second',
      unitDisplay: 'narrow',
      maximumFractionDigits: 1,
    });
  }
  return formatNumber(value / MS_PER_MINUTE, options, {
    style: 'unit',
    unit: 'minute',
    unitDisplay: 'short',
    maximumFractionDigits: 0,
  });
}

/** A throughput or ETA in seconds: "18 min", "1 h", "3 days". */
export function formatDuration(seconds: number, options: FormatOptions): string {
  if (!Number.isFinite(seconds)) return '—';
  const absolute = Math.abs(seconds);
  const [unit, divisor] = pickTimeUnit(absolute);
  return formatNumber(seconds / divisor, options, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: absolute < MINUTE ? 0 : 1,
  });
}

type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year';

function pickTimeUnit(absoluteSeconds: number): readonly [TimeUnit, number] {
  if (absoluteSeconds < MINUTE) return ['second', SECOND];
  if (absoluteSeconds < HOUR) return ['minute', MINUTE];
  if (absoluteSeconds < DAY) return ['hour', HOUR];
  if (absoluteSeconds < MONTH) return ['day', DAY];
  if (absoluteSeconds < YEAR) return ['month', MONTH];
  return ['year', YEAR];
}

/**
 * "4 min ago" / "in 3 days". `offsetSeconds` is signed, past is negative — the
 * same convention the concept used in `data-rel`.
 */
export function formatRelativeSeconds(offsetSeconds: number, { locale }: FormatOptions): string {
  const absolute = Math.abs(offsetSeconds);
  const [unit, divisor] = pickTimeUnit(absolute);
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }).format(
    Math.round(offsetSeconds / divisor),
    unit,
  );
}

export function formatRelativeTo(iso: string, options: FormatOptions, now = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return '—';
  return formatRelativeSeconds((timestamp - now) / MS_IN_SECOND, options);
}

export type DateTimeStyle = 'date' | 'time' | 'datetime' | 'long';

const DATE_TIME_STYLES: Readonly<Record<DateTimeStyle, Intl.DateTimeFormatOptions>> = {
  date: { dateStyle: 'medium' },
  time: { timeStyle: 'short' },
  datetime: { dateStyle: 'medium', timeStyle: 'short' },
  long: { dateStyle: 'full', timeStyle: 'medium' },
};

export function formatDateTime(
  value: string | number | Date,
  options: FormatOptions,
  style: DateTimeStyle = 'datetime',
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const { locale, region } = options;
  return new Intl.DateTimeFormat(locale, {
    ...DATE_TIME_STYLES[style],
    timeZone: region.timezone === 'auto' ? undefined : region.timezone,
  }).format(date);
}

/** A byte-rate: "48 MB/s", localised number, unit suffix from formatBytes. */
export function formatBytesPerSecond(value: number, options: FormatOptions): string {
  return `${formatBytes(value, options)}/s`;
}

/** Below this, a rate rounded to whole units reads as a flat zero. */
const RATE_FRACTION_THRESHOLD = 10;

/**
 * A plain per-second rate: "1,840/s", "0.03/s". Traffic rates span four orders of
 * magnitude between an idle server and a busy one, so the fraction digits follow
 * the value rather than being fixed.
 */
export function formatPerSecond(value: number, options: FormatOptions): string {
  const digits = value > 0 && value < RATE_FRACTION_THRESHOLD ? 2 : 0;
  const number = formatNumber(value, options, { maximumFractionDigits: digits });
  return `${number}/s`;
}
