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
import {
  METRIC_SERIES,
  needsTraffic,
  pointCountFor,
  type MetricSeries,
} from '@/features/servers/metricSeries';
import { useApiError } from '@/lib/api/useApiError';

/**
 * Recharts is ~100 kB and only this card needs it, so the chart itself is a lazy
 * chunk and the card shows a skeleton of the same height while it arrives — no
 * layout jump when it lands.
 *
 * Four series: the concept's Traffic (requests per second) and its throughput
 * companion, both from `metrics.traffic`, plus the response time and used
 * capacity the health checker records itself.
 *
 * `metrics.traffic` is `null` for a provider with no metrics endpoint and an
 * empty array for one that has simply not been sampled in this range. The
 * contract draws that distinction deliberately, so this card does too: `null`
 * says the provider cannot report it and points at the other two series, `[]`
 * gets the ordinary "not enough samples yet" state.
 */
const ServerMetricsChart = lazy(
  () => import('@/features/servers/components/ServerMetricsChart'),
);

/** A minimum of two points, or there is a dot on an axis rather than a chart. */
const MIN_POINTS = 2;

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
  // Null until the operator picks one, so the default can follow the server:
  // opening a SeaweedFS server on "Traffic — not available" would be a worse
  // first impression than opening it on the series it does have.
  const [chosen, setChosen] = useState<MetricSeries | null>(null);

  const trafficAvailable = metrics?.traffic != null;
  const series: MetricSeries = chosen ?? (trafficAvailable ? 'traffic' : 'latency');

  const rangeOptions = useMemo<readonly SegmentedOption<MetricRange>[]>(
    () => METRIC_RANGES.map((value) => ({ value, label: t(`server.metrics.range.${value}`) })),
    [t],
  );

  const seriesOptions = useMemo<readonly SegmentedOption<MetricSeries>[]>(
    () => METRIC_SERIES.map((value) => ({ value, label: t(`server.metrics.series.${value}`) })),
    [t],
  );

  const points = metrics === undefined ? 0 : pointCountFor(metrics, series);
  const trafficMissing = metrics !== undefined && needsTraffic(series) && !trafficAvailable;

  return (
    <SectionCard
      title={t('server.metrics.title')}
      description={t('server.metrics.description')}
      action={
        <>
          <SegmentedControl
            options={seriesOptions}
            value={series}
            onValueChange={setChosen}
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
      ) : trafficMissing ? (
        <EmptyState
          icon={ActivityIcon}
          title={t('server.metrics.trafficUnavailableTitle')}
          description={t('server.metrics.trafficUnavailableDescription')}
        />
      ) : metrics === undefined || points < MIN_POINTS ? (
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
