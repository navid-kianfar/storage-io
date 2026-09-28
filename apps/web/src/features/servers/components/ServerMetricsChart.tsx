import type { ServerMetrics } from '@storage-io/contracts';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/app';
import { useFormat } from '@/lib/format/FormatProvider';

/**
 * The server's own metric chart. Loaded lazily by `ServerMetricsCard` so Recharts
 * stays out of the initial bundle.
 *
 * Two series, one at a time, because they have different units: response time in
 * milliseconds and used capacity in bytes. The y-axis formatter goes through
 * `useFormat`, so the axis obeys the installation's size units and digit settings
 * exactly like every other number on the page.
 */
export type MetricSeries = 'latency' | 'capacity';

interface Point {
  readonly t: string;
  readonly value: number;
}

export default function ServerMetricsChart({
  metrics,
  series,
}: {
  readonly metrics: ServerMetrics;
  readonly series: MetricSeries;
}) {
  const { t } = useTranslation('pages');
  const format = useFormat();

  const data: readonly Point[] =
    series === 'latency'
      ? metrics.latency.map((point) => ({ t: point.t, value: point.ms }))
      : metrics.capacity.map((point) => ({ t: point.t, value: point.usedBytes }));

  const label = t(`server.metrics.series.${series}`);
  const config: ChartConfig = { value: { label, color: 'var(--chart-1)' } };
  const formatValue = (value: number) =>
    series === 'latency' ? format.milliseconds(value) : format.bytes(value);

  return (
    <ChartContainer config={config} className="h-56 w-full">
      <AreaChart data={[...data]} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="sio-server-metric" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--chart-1)" stopOpacity={0.26} />
            <stop offset="1" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="t"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={48}
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickFormatter={(value: string) => format.dateTime(value, 'time')}
        />
        <YAxis
          width={56}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickFormatter={formatValue}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) => {
                const first = payload.at(0)?.payload as Point | undefined;
                return first === undefined ? '' : format.dateTime(first.t, 'datetime');
              }}
              formatter={(value) => formatValue(Number(value))}
            />
          }
        />
        <Area
          dataKey="value"
          name={label}
          type="monotone"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#sio-server-metric)"
        />
      </AreaChart>
    </ChartContainer>
  );
}
