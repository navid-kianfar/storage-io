import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useFormat } from '@/lib/format/FormatProvider';
import type { DateTimeStyle } from '@/lib/format/formatters';

/**
 * Display components for every formatted value. Use these rather than calling
 * `useFormat()` in a page: they carry `tabular-nums` and the `<time>` semantics,
 * and `<RelativeTime>` keeps itself current without the page owning a timer.
 */

const NUMERIC_CLASS = 'num';

const MS_IN_SECOND = 1000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 3600;
/** Refresh cadence: every 10 s under a minute old, every minute under an hour, else hourly. */
const TICK_UNDER_MINUTE_MS = 10 * MS_IN_SECOND;
const TICK_UNDER_HOUR_MS = 60 * MS_IN_SECOND;
const TICK_OTHERWISE_MS = 60 * 60 * MS_IN_SECOND;

export interface ValueProps {
  readonly className?: string;
}

export function Bytes({ value, className }: ValueProps & { readonly value: number | null }) {
  const format = useFormat();
  if (value === null) return <Dash className={className} />;
  return <span className={cn(NUMERIC_CLASS, className)}>{format.bytes(value)}</span>;
}

export function BytesPerSecond({
  value,
  className,
}: ValueProps & { readonly value: number | null }) {
  const format = useFormat();
  if (value === null) return <Dash className={className} />;
  return <span className={cn(NUMERIC_CLASS, className)}>{format.bytesPerSecond(value)}</span>;
}

export function Num({
  value,
  compact = false,
  className,
}: ValueProps & { readonly value: number | null; readonly compact?: boolean }) {
  const format = useFormat();
  if (value === null) return <Dash className={className} />;
  return (
    <span className={cn(NUMERIC_CLASS, className)}>
      {compact ? format.compact(value) : format.number(value, { maximumFractionDigits: 0 })}
    </span>
  );
}

export function Pct({
  value,
  fractionDigits = 0,
  className,
}: ValueProps & { readonly value: number | null; readonly fractionDigits?: number }) {
  const format = useFormat();
  if (value === null) return <Dash className={className} />;
  return (
    <span className={cn(NUMERIC_CLASS, className)}>{format.percent(value, fractionDigits)}</span>
  );
}

export function Ms({ value, className }: ValueProps & { readonly value: number | null }) {
  const format = useFormat();
  if (value === null) return <Dash className={className} />;
  return <span className={cn(NUMERIC_CLASS, className)}>{format.milliseconds(value)}</span>;
}

export function Duration({ seconds, className }: ValueProps & { readonly seconds: number | null }) {
  const format = useFormat();
  if (seconds === null) return <Dash className={className} />;
  return <span className={cn(NUMERIC_CLASS, className)}>{format.duration(seconds)}</span>;
}

export function DateTime({
  value,
  style = 'datetime',
  className,
}: ValueProps & { readonly value: string | null; readonly style?: DateTimeStyle }) {
  const format = useFormat();
  if (value === null) return <Dash className={className} />;
  return (
    <time dateTime={value} className={className}>
      {format.dateTime(value, style)}
    </time>
  );
}

function tickIntervalFor(ageSeconds: number): number {
  if (ageSeconds < MINUTE_SECONDS) return TICK_UNDER_MINUTE_MS;
  if (ageSeconds < HOUR_SECONDS) return TICK_UNDER_HOUR_MS;
  return TICK_OTHERWISE_MS;
}

/**
 * "4 min ago", refreshed on its own schedule. The interval widens with the age of
 * the value, so a page listing hundreds of old timestamps is not re-rendering
 * every second for no visible change.
 */
export function RelativeTime({
  value,
  className,
  title,
}: ValueProps & { readonly value: string | null; readonly title?: string }) {
  const format = useFormat();
  const [now, setNow] = useState(() => Date.now());

  const timestamp = value === null ? Number.NaN : Date.parse(value);
  const ageSeconds = Number.isNaN(timestamp) ? 0 : Math.abs((now - timestamp) / MS_IN_SECOND);

  useEffect(() => {
    if (Number.isNaN(timestamp)) return;
    const interval = window.setInterval(() => setNow(Date.now()), tickIntervalFor(ageSeconds));
    return () => window.clearInterval(interval);
  }, [timestamp, ageSeconds]);

  if (value === null || Number.isNaN(timestamp)) return <Dash className={className} />;

  return (
    <time dateTime={value} className={className} title={title ?? format.dateTime(value, 'long')}>
      {format.relativeTo(value, now)}
    </time>
  );
}

/** The one place the "no value" glyph is spelled, so every table agrees. */
export function Dash({ className }: ValueProps) {
  return (
    <span className={cn('text-muted-foreground', className)} aria-hidden="true">
      —
    </span>
  );
}
