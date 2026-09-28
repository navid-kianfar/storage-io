import { SETTINGS_DEFAULTS, type RegionSettings } from '@storage-io/contracts';
import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCompact,
  formatDuration,
  formatMilliseconds,
  formatPercent,
  formatPerSecond,
  formatRelativeSeconds,
  intlLocale,
  type FormatOptions,
} from './formatters';

const region: RegionSettings = SETTINGS_DEFAULTS.region;

function options(overrides: Partial<FormatOptions> = {}): FormatOptions {
  return { locale: 'en', region, ...overrides };
}

/** Never rely on the contract's default here: each mode is asserted explicitly. */
const decimal = options({ region: { ...region, sizeUnits: 'decimal' } });
const binary = options({ region: { ...region, sizeUnits: 'binary' } });

const KB = 1000;
const MB = KB * 1000;
const TB = MB * MB;
const KIB = 1024;
const MIB = KIB * 1024;

describe('formatBytes', () => {
  it('uses Intl byte units in decimal mode', () => {
    expect(formatBytes(0, decimal)).toBe('0 byte');
    expect(formatBytes(940, decimal)).toBe('940 byte');
    expect(formatBytes(1.5 * MB, decimal)).toBe('1.5 MB');
    expect(formatBytes(18.4 * TB, decimal)).toBe('18.4 TB');
  });

  it('drops the decimal above 100 units, where it adds nothing', () => {
    expect(formatBytes(128 * MB, decimal)).toBe('128 MB');
  });

  it('uses 1024 steps and IEC suffixes in binary mode', () => {
    expect(formatBytes(0, binary)).toBe('0 B');
    expect(formatBytes(KIB, binary)).toBe('1 KiB');
    expect(formatBytes(1.5 * MIB, binary)).toBe('1.5 MiB');
    // 1.28e8 bytes is 122 MiB, not 128: the two modes must not agree.
    expect(formatBytes(128 * MB, binary)).toBe('122 MiB');
  });

  it('localises the digits, not just the number', () => {
    // Persian uses Eastern Arabic-Indic digits, so the output must not be ASCII.
    const persian = formatBytes(1.5 * MB, { ...decimal, locale: 'fa' });
    expect(persian).not.toMatch(/[0-9]/);
  });

  it('reports a non-finite size as a dash rather than "NaN B"', () => {
    expect(formatBytes(Number.NaN, decimal)).toBe('—');
  });
});

describe('numbers and percentages', () => {
  it('formats compact counts', () => {
    expect(formatCompact(48_200_000, options())).toBe('48.2M');
  });

  it('formats a ratio as a percentage with no decimals by default', () => {
    expect(formatPercent(0.56, options())).toBe('56%');
    expect(formatPercent(0.934, options(), 1)).toBe('93.4%');
  });
});

describe('durations', () => {
  it('scales milliseconds up through seconds and minutes', () => {
    expect(formatMilliseconds(12, options())).toBe('12ms');
    expect(formatMilliseconds(1400, options())).toBe('1.4s');
    expect(formatMilliseconds(180_000, options())).toBe('3 min');
  });

  it('picks the unit an ETA should be read in', () => {
    expect(formatDuration(45, options())).toBe('45 sec');
    expect(formatDuration(1080, options())).toBe('18 min');
    expect(formatDuration(7200, options())).toBe('2 hr');
  });
});

describe('formatRelativeSeconds', () => {
  it('reads the past as "ago" and the future as "in"', () => {
    // `style: 'short'` is the concept's wording, abbreviation dot included.
    expect(formatRelativeSeconds(-240, options())).toBe('4 min. ago');
    expect(formatRelativeSeconds(3 * 86_400, options())).toBe('in 3 days');
  });

  it('uses the "auto" wording for now-ish values', () => {
    expect(formatRelativeSeconds(0, options())).toBe('now');
  });
});

describe('intlLocale', () => {
  it('passes the language through when nothing is overridden', () => {
    expect(intlLocale('en', region)).toBe('en');
  });

  it('adds the calendar and numbering-system extensions the settings ask for', () => {
    expect(intlLocale('fa', { ...region, calendar: 'persian' })).toBe('fa-u-ca-persian');
    expect(intlLocale('fa', { ...region, digits: 'latn' })).toBe('fa-u-nu-latn');
    expect(intlLocale('fa', { ...region, calendar: 'gregory', digits: 'latn' })).toBe(
      'fa-u-ca-gregory-nu-latn',
    );
  });
});

/**
 * Traffic rates span four orders of magnitude between an idle server and a busy
 * one, so a fixed number of fraction digits either rounds an idle server to a
 * flat zero or fills a busy one's axis with noise.
 */
describe('formatPerSecond', () => {
  it('keeps two fraction digits for a rate below ten', () => {
    expect(formatPerSecond(0.0333, options())).toBe('0.03/s');
    expect(formatPerSecond(9.876, options())).toBe('9.88/s');
  });

  it('rounds to whole units from ten upward, with a thousands separator', () => {
    expect(formatPerSecond(93.6, options())).toBe('94/s');
    expect(formatPerSecond(1840.4, options())).toBe('1,840/s');
  });

  it('shows an exact zero rather than "0.00"', () => {
    expect(formatPerSecond(0, options())).toBe('0/s');
  });
});
