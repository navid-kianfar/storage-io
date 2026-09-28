import type { MetricRange, ServerMetrics } from '@storage-io/contracts';
import { METRIC_RANGES } from '@storage-io/contracts';
import { ActivityIcon } from 'lucide-react';
import { Suspense, lazy, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  EmptyState,
  SectionCard,
  SegmentedControl,
  Skeleton,
  type SegmentedOption,
} from '@/components/app';
import type { MetricSeries } from '@/features/servers/components/ServerMetricsChart';
import { useApiError } from '@/lib/api/useApiError';

/**
 * Recharts is ~100 kB and only this card needs it, so the chart itself is a lazy
 * chunk and the card shows a skeleton of the same height while it arrives — no
 * layout jump when it lands.
 *
 * Deviation from the concept, named on purpose: the concept's card is "Traffic —
 * requests per second", and `GET /servers/:id/metrics` carries capacity and
 * latency but no request counter. Rather than draw a number the API does not
 * have, this charts the two series that exist, with the range the contract
 * accepts.
 */
const ServerMetricsChart = lazy(
  () => import('@/features/servers/components/ServerMetricsChart'),
);

export function ServerMetricsCard({
  metrics,
  loading,
  error,
  range,
  onRangeChange,
}: {
  readonly metrics: ServerMetrics | undefined;
  readonly loading: boolean;
  readonly error: unknown;
  readonly range: MetricRange;
  readonly onRangeChange: (range: MetricRange) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const [series, setSeries] = useState<MetricSeries>('latency');

  const rangeOptions = useMemo<readonly SegmentedOption<MetricRange>[]>(
    () => METRIC_RANGES.map((value) => ({ value, label: t(`server.metrics.range.${value}`) })),
    [t],
  );

  const seriesOptions = useMemo<readonly SegmentedOption<MetricSeries>[]>(
    () => [
      { value: 'latency', label: t('server.metrics.series.latency') },
      { value: 'capacity', label: t('server.metrics.series.capacity') },
    ],
    [t],
  );

  const points = metrics === undefined ? 0 : series === 'latency' ? metrics.latency.length : metrics.capacity.length;

  return (
    <SectionCard
      title={t('server.metrics.title')}
      description={t('server.metrics.description')}
      action={
        <>
          <SegmentedControl
            options={seriesOptions}
            value={series}
            onValueChange={setSeries}
            aria-label={t('server.metrics.seriesLabel')}
          />
          <SegmentedControl
            options={rangeOptions}
            value={range}
            onValueChange={onRangeChange}
            aria-label={t('server.metrics.rangeLabel')}
          />
        </>
      }
    >
      {loading ? (
        <Skeleton className="h-56 w-full" />
      ) : error !== null && error !== undefined ? (
        <EmptyState
          icon={ActivityIcon}
          title={tCommon('state.error')}
          description={apiError.message(error)}
        />
      ) : metrics === undefined || points < 2 ? (
        <EmptyState
          icon={ActivityIcon}
          title={t('server.metrics.emptyTitle')}
          description={t('server.metrics.emptyDescription')}
        />
      ) : (
        <Suspense fallback={<Skeleton className="h-56 w-full" />}>
          <ServerMetricsChart metrics={metrics} series={series} />
        </Suspense>
      )}
    </SectionCard>
  );
}
