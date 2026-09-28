import { useTranslation } from 'react-i18next';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/app/Chart';
import { useFormat } from '@/lib/format/FormatProvider';
import type { ThroughputSample } from '@/stores/transfers';

/**
 * Upload and download throughput over the last ten minutes.
 *
 * In its own module because Recharts is large and only this card needs it — the
 * page loads it with `lazy()`, which keeps it out of the initial bundle exactly as
 * apps/web/README.md asks.
 *
 * The axis and the tooltip go through `useFormat`, so "24.1 MB/s" obeys the
 * operator's size-unit and locale settings like every other number in the app.
 */
export function ThroughputChart({ samples }: { readonly samples: readonly ThroughputSample[] }) {
  const { t } = useTranslation('pages');
  const format = useFormat();

  const config: ChartConfig = {
    up: { label: t('transfers.chart.upload'), color: 'var(--chart-1)' },
    down: { label: t('transfers.chart.download'), color: 'var(--chart-2)' },
  };

  const data = samples.map((sample) => ({
    t: sample.t,
    up: sample.up,
    down: sample.down,
  }));

  const peakUp = samples.reduce((max, sample) => Math.max(max, sample.up), 0);
  const peakDown = samples.reduce((max, sample) => Math.max(max, sample.down), 0);

  return (
    <div className="flex flex-col gap-3">
      <ChartContainer config={config} className="h-36 w-full">
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="t"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={48}
            tickFormatter={(value: number) => format.dateTime(value, 'time')}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={72}
            tickFormatter={(value: number) => format.bytesPerSecond(value)}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_label, payload) => {
                  const point = payload[0]?.payload as { t: number } | undefined;
                  return point === undefined ? '' : format.dateTime(point.t, 'time');
                }}
                formatter={(value) => format.bytesPerSecond(Number(value))}
              />
            }
          />
          <Area
            dataKey="up"
            type="monotone"
            stroke="var(--color-up)"
            fill="var(--color-up)"
            fillOpacity={0.2}
            strokeWidth={2}
          />
          <Area
            dataKey="down"
            type="monotone"
            stroke="var(--color-down)"
            fill="var(--color-down)"
            fillOpacity={0.15}
            strokeWidth={2}
          />
        </AreaChart>
      </ChartContainer>

      <dl className="flex flex-col gap-1.5 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">{t('transfers.chart.peakUpload')}</dt>
          <dd className="num">{format.bytesPerSecond(peakUp)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">{t('transfers.chart.peakDownload')}</dt>
          <dd className="num">{format.bytesPerSecond(peakDown)}</dd>
        </div>
      </dl>
    </div>
  );
}
