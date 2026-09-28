import type { Dashboard } from '@storage-io/contracts';
import { Area, AreaChart, CartesianGrid, Line, ReferenceLine, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/app';
import { useFormat } from '@/lib/format/FormatProvider';

/**
 * Storage growth over the last 30 days, with the projection the concept draws as
 * a dashed line.
 *
 * The projection is an ordinary least-squares fit over the points the API sent,
 * extended by a third of the observed window. It is labelled "projected" in the
 * legend and the tooltip and drawn dashed, because it is arithmetic on past
 * points, not a number the API stands behind — the reference line marks where the
 * measurements stop and the estimate starts.
 */

const PROJECTION_FRACTION = 1 / 3;
const DAY_MS = 86_400_000;
const MIN_POINTS_FOR_FIT = 3;

interface Row {
  readonly t: string;
  readonly used: number | null;
  readonly projected: number | null;
}

/** y = a + b·x over the index, which is what a daily series gives for free. */
function fit(values: readonly number[]): { readonly a: number; readonly b: number } {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let variance = 0;
  for (const [index, value] of values.entries()) {
    const dx = index - meanX;
    covariance += dx * (value - meanY);
    variance += dx * dx;
  }
  const b = variance === 0 ? 0 : covariance / variance;
  return { a: meanY - b * meanX, b };
}

export default function GrowthChart({ growth }: { readonly growth: Dashboard['growth'] }) {
  const { t } = useTranslation('pages');
  const format = useFormat();

  const observed = growth.map((point) => point.usedBytes);
  const lastPoint = growth.at(-1);
  const canProject = growth.length >= MIN_POINTS_FOR_FIT && lastPoint !== undefined;

  const rows: Row[] = growth.map((point, index) => ({
    t: point.t,
    used: point.usedBytes,
    // The projection starts on the last measured point so the two lines meet.
    projected: canProject && index === growth.length - 1 ? point.usedBytes : null,
  }));

  if (canProject) {
    const { a, b } = fit(observed);
    const extra = Math.max(1, Math.round(growth.length * PROJECTION_FRACTION));
    const lastTime = Date.parse(lastPoint.t);
    for (let step = 1; step <= extra; step += 1) {
      const index = growth.length - 1 + step;
      rows.push({
        t: new Date(lastTime + step * DAY_MS).toISOString(),
        used: null,
        projected: Math.max(0, a + b * index),
      });
    }
  }

  const config: ChartConfig = {
    used: { label: t('overview.growth.used'), color: 'var(--chart-1)' },
    projected: { label: t('overview.growth.projected'), color: 'var(--muted-foreground)' },
  };

  return (
    <ChartContainer config={config} className="h-52 w-full">
      <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="sio-growth" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--chart-1)" stopOpacity={0.28} />
            <stop offset="1" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="t"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={56}
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickFormatter={(value: string) => format.dateTime(value, 'date')}
        />
        <YAxis
          width={60}
          tickLine={false}
          axisLine={false}
          domain={['auto', 'auto']}
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickFormatter={(value: number) => format.bytes(value)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) => {
                const first = payload.at(0)?.payload as Row | undefined;
                return first === undefined ? '' : format.dateTime(first.t, 'date');
              }}
              formatter={(value) => format.bytes(Number(value))}
            />
          }
        />
        {canProject ? (
          <ReferenceLine x={lastPoint.t} stroke="var(--border)" strokeWidth={1} />
        ) : null}
        <Area
          dataKey="used"
          name={t('overview.growth.used')}
          type="monotone"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#sio-growth)"
          connectNulls={false}
        />
        <Line
          dataKey="projected"
          name={t('overview.growth.projected')}
          type="monotone"
          stroke="var(--muted-foreground)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          dot={false}
          connectNulls
        />
      </AreaChart>
    </ChartContainer>
  );
}
