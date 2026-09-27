import { cn } from '@/lib/utils';

/**
 * The quota / capacity bar. The thresholds are the product's, not a component
 * detail, so they live here as named constants and every screen agrees on when a
 * bucket is "near" its limit.
 */
export const METER_WARN_RATIO = 0.8;
export const METER_CRIT_RATIO = 0.9;

export type MeterTone = 'default' | 'ok' | 'warn' | 'crit';

export function meterToneFor(ratio: number | null): MeterTone {
  if (ratio === null) return 'default';
  if (ratio >= METER_CRIT_RATIO) return 'crit';
  if (ratio >= METER_WARN_RATIO) return 'warn';
  return 'default';
}

const TONE_CLASSES: Readonly<Record<MeterTone, string>> = {
  default: 'bg-primary',
  ok: 'bg-success',
  warn: 'bg-warning',
  crit: 'bg-destructive',
};

const SIZE_CLASSES = {
  sm: 'h-1.5',
  md: 'h-2',
  lg: 'h-2.5',
} as const;

export type MeterSize = keyof typeof SIZE_CLASSES;

const FULL_PERCENT = 100;

export function Meter({
  value,
  tone,
  size = 'sm',
  striped = false,
  label,
  className,
}: {
  /** 0..1. Values above 1 are clamped for the bar but keep their tone. */
  readonly value: number | null;
  /** Overrides the threshold-derived tone (a running job uses `default`). */
  readonly tone?: MeterTone;
  readonly size?: MeterSize;
  /** Animated stripes: work in flight, as on the dashboard's job cards. */
  readonly striped?: boolean;
  /** Accessible name — required whenever the bar is not next to its own text. */
  readonly label?: string;
  readonly className?: string;
}) {
  const ratio = value === null ? 0 : Math.max(0, Math.min(1, value));
  const resolvedTone = tone ?? meterToneFor(value);

  return (
    <div
      role="meter"
      aria-valuenow={value === null ? undefined : Math.round(ratio * FULL_PERCENT)}
      aria-valuemin={0}
      aria-valuemax={FULL_PERCENT}
      aria-label={label}
      className={cn(
        'relative min-w-16 overflow-hidden rounded-full bg-muted',
        SIZE_CLASSES[size],
        className,
      )}
    >
      <span
        className={cn(
          'block h-full rounded-[inherit] transition-[width] duration-500 ease-concept',
          TONE_CLASSES[resolvedTone],
          striped && 'meter-striped',
        )}
        style={{ width: `${ratio * FULL_PERCENT}%` }}
      />
    </div>
  );
}

export interface MeterSegment {
  readonly value: number;
  readonly className: string;
  readonly label: string;
}

/**
 * The stacked variant: healthy / degraded / offline on the dashboard KPI, or a
 * password-strength bar. Segments are ratios of the whole.
 */
export function MeterStack({
  segments,
  className,
}: {
  readonly segments: readonly MeterSegment[];
  readonly className?: string;
}) {
  return (
    <div className={cn('flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted', className)}>
      {segments.map((segment) => (
        <span
          key={segment.label}
          title={segment.label}
          className={segment.className}
          style={{ width: `${Math.max(0, Math.min(1, segment.value)) * FULL_PERCENT}%` }}
        />
      ))}
    </div>
  );
}
