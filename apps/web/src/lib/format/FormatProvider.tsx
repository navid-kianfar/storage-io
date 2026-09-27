import { SETTINGS_DEFAULTS, type RegionSettings } from '@storage-io/contracts';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  formatBytes,
  formatBytesPerSecond,
  formatCompact,
  formatDateTime,
  formatDuration,
  formatMilliseconds,
  formatNumber,
  formatPercent,
  formatRelativeSeconds,
  formatRelativeTo,
  intlLocale,
  type DateTimeStyle,
  type FormatOptions,
} from './formatters';
import { usePreferences, type Language } from '@/stores/preferences';

/**
 * Formatting depends on two things: the UI language (a per-browser preference)
 * and `Settings.region` (an installation setting: size units, calendar, digits,
 * timezone). This context resolves both once and exposes bound formatters, so no
 * component constructs an `Intl.NumberFormat` of its own.
 *
 * `region` is optional on purpose: /login renders before `GET /settings` is
 * allowed, and falls back to the contract's documented defaults.
 */
export interface FormatApi {
  readonly locale: string;
  readonly language: Language;
  readonly region: RegionSettings;
  bytes: (value: number) => string;
  bytesPerSecond: (value: number) => string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  compact: (value: number) => string;
  percent: (ratio: number, fractionDigits?: number) => string;
  milliseconds: (value: number) => string;
  duration: (seconds: number) => string;
  relativeSeconds: (offsetSeconds: number) => string;
  relativeTo: (iso: string, now?: number) => string;
  dateTime: (value: string | number | Date, style?: DateTimeStyle) => string;
}

const FormatContext = createContext<FormatApi | null>(null);

export function FormatProvider({
  region,
  children,
}: {
  readonly region?: RegionSettings;
  readonly children: ReactNode;
}) {
  const language = usePreferences((state) => state.language);
  const resolvedRegion = region ?? SETTINGS_DEFAULTS.region;

  const value = useMemo<FormatApi>(() => {
    const options: FormatOptions = {
      locale: intlLocale(language, resolvedRegion),
      region: resolvedRegion,
    };
    return {
      locale: options.locale,
      language,
      region: resolvedRegion,
      bytes: (input) => formatBytes(input, options),
      bytesPerSecond: (input) => formatBytesPerSecond(input, options),
      number: (input, numberOptions) => formatNumber(input, options, numberOptions),
      compact: (input) => formatCompact(input, options),
      percent: (ratio, fractionDigits) => formatPercent(ratio, options, fractionDigits),
      milliseconds: (input) => formatMilliseconds(input, options),
      duration: (seconds) => formatDuration(seconds, options),
      relativeSeconds: (offsetSeconds) => formatRelativeSeconds(offsetSeconds, options),
      relativeTo: (iso, now) => formatRelativeTo(iso, options, now),
      dateTime: (input, style) => formatDateTime(input, options, style),
    };
  }, [language, resolvedRegion]);

  return <FormatContext.Provider value={value}>{children}</FormatContext.Provider>;
}

export function useFormat(): FormatApi {
  const context = useContext(FormatContext);
  if (!context) throw new Error('useFormat must be used inside a <FormatProvider>.');
  return context;
}
