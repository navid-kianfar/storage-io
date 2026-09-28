import type { ServerMetrics } from '@storage-io/contracts';
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/app';
import {
  SERIES_LINES,
  SERIES_UNITS,
  rowsFor,
  type MetricRow,
  type MetricSeries,
} from '@/features/servers/metricSeries';
import { useFormat } from '@/lib/format/FormatProvider';

/**
 * The server's metric chart. Loaded lazily by `ServerMetricsCard` so Recharts
 * stays out of the initial bundle; the series definitions live in
 * `../metricSeries` so the card can read them without loading this.
 *
 * One series at a time, because the four have four different units. Every value
 * goes through `useFormat`, so the axis and the tooltip obey the installation's
 * size units and digit settings like every other number on the page.
 */
export default function ServerMetricsChart({
  metrics,
  series,
}: {
  readonly metrics: ServerMetrics;
  readonly series: MetricSeries;
}) {
  const { t } = useTranslation('pages');
  const format = useFormat();

  const rows = rowsFor(metrics, series);
  const lines = SERIES_LINES[series];
  const unit = SERIES_UNITS[series];

  const formatValue = (value: number): string => {
    switch (unit) {
      case 'perSecond':
        return format.perSecond(value);
      case 'bytesPerSecond':
        return format.bytesPerSecond(value);
      case 'milliseconds':
        return format.milliseconds(value);
      case 'bytes':
        return format.bytes(value);
    }
  };

  const config: ChartConfig = Object.fromEntries(
    lines.map((line) => [
      line.key,
      { label: t(`server.metrics.line.${line.key}`), color: line.color },
    ]),
  );

  return (
    <ChartContainer config={config} className="h-56 w-full">
      <ComposedChart data={[...rows]} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          {lines
            .filter((line) => line.filled)
            .map((line) => (
              <linearGradient
                key={line.key}
                id={`sio-metric-${line.key}`}
                x1="0"
                x2="0"
                y1="0"
                y2="1"
              >
                <stop offset="0" stopColor={line.color} stopOpacity={0.26} />
                <stop offset="1" stopColor={line.color} stopOpacity={0} />
              </linearGradient>
            ))}
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
          width={64}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickFormatter={formatValue}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) => {
                const first = payload.at(0)?.payload as MetricRow | undefined;
                const at = first?.t;
                return typeof at === 'string' ? format.dateTime(at, 'datetime') : '';
              }}
              formatter={(value, name) => (
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    {t(`server.metrics.line.${String(name)}`)}
                  </span>
                  <span className="num font-medium">{formatValue(Number(value))}</span>
                </span>
              )}
            />
          }
        />
        {lines.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
        {lines.map((line) =>
          line.filled ? (
            <Area
              key={line.key}
              dataKey={line.key}
              name={line.key}
              type="monotone"
              stroke={line.color}
              strokeWidth={2}
              fill={`url(#sio-metric-${line.key})`}
            />
          ) : (
            <Line
              key={line.key}
              dataKey={line.key}
              name={line.key}
              type="monotone"
              stroke={line.color}
              strokeWidth={2}
              dot={false}
            />
          ),
        )}
      </ComposedChart>
    </ChartContainer>
  );
}
