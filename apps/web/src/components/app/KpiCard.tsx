import type { LucideIcon } from 'lucide-react';
import { TrendingDownIcon, TrendingUpIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * The dashboard's KPI tile (`.kpi` in the concept): a label, a big value with an
 * optional `/ total` suffix, an icon tile in the corner, and a footer that holds
 * a delta, a meter or a badge.
 */
export function KpiCard({
  label,
  value,
  suffix,
  icon: Icon,
  children,
  footer,
  className,
}: {
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** The smaller "/ 33 TB" part after the value. */
  readonly suffix?: ReactNode;
  readonly icon?: LucideIcon;
  /** A Meter, a Sparkline — sits between the value and the footer. */
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}) {
  return (
    <Card
      className={cn('relative gap-2 overflow-hidden p-(--card-pad) py-(--card-pad)', className)}
    >
      {Icon ? (
        <span className="absolute top-4 end-4 grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </span>
      ) : null}
      <div className="flex items-center gap-2 pe-10 text-[0.8125rem] font-medium text-muted-foreground">
        {label}
      </div>
      <div className="num text-(length:--kpi-fs) leading-[1.1] font-semibold tracking-[-0.02em]">
        {value}
        {suffix ? (
          <small className="ms-1 text-[0.5em] font-medium tracking-normal text-muted-foreground">
            {suffix}
          </small>
        ) : null}
      </div>
      {children}
      {footer ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">{footer}</div>
      ) : null}
    </Card>
  );
}

/** The green / red delta chip in a KPI footer. */
export function Delta({
  direction,
  children,
  className,
}: {
  readonly direction: 'up' | 'down';
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const Icon = direction === 'up' ? TrendingUpIcon : TrendingDownIcon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-semibold',
        direction === 'up' ? 'text-success' : 'text-destructive',
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {children}
    </span>
  );
}

const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 30;
const SPARK_PADDING = 2;

/**
 * A tiny inline trend line. Hand-drawn SVG rather than Recharts: a KPI card may
 * hold a dozen of these, and Recharts' ResponsiveContainer costs a resize
 * observer each. Use the shadcn Chart (Recharts) for anything with axes,
 * tooltips or a legend.
 */
export function Sparkline({
  values,
  tone = 'chart-1',
  filled = true,
  className,
  ariaLabel,
}: {
  readonly values: readonly number[];
  readonly tone?: 'chart-1' | 'chart-2' | 'chart-3' | 'chart-4' | 'chart-5';
  readonly filled?: boolean;
  readonly className?: string;
  /** Sparklines carry no axis, so the summary has to be spelled out. */
  readonly ariaLabel: string;
}) {
  const gradientId = useId();
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = SPARK_WIDTH / (values.length - 1);
  const usableHeight = SPARK_HEIGHT - SPARK_PADDING * 2;

  const points = values.map((value, index) => {
    const x = index * stepX;
    const y = SPARK_PADDING + usableHeight - ((value - min) / span) * usableHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = `M${points.join(' L')}`;
  const area = `${line} L${SPARK_WIDTH},${SPARK_HEIGHT} L0,${SPARK_HEIGHT} Z`;
  const stroke = `var(--${tone})`;

  return (
    <svg
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
      // No `dir` needed: SVG coordinates are not affected by the document
      // direction, so the trend still runs left to right on an RTL page.
      className={cn('h-10 w-full overflow-visible', className)}
    >
      {filled ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={stroke} stopOpacity="0.22" />
              <stop offset="1" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradientId})`} />
        </>
      ) : null}
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
