import type { ServerMetrics } from '@storage-io/contracts';

/**
 * What the server's metric card can draw, and how each series is shaped.
 *
 * This is deliberately separate from `ServerMetricsChart`: the card needs the
 * series list and the point counts to choose between the chart, the "not
 * available" note and the empty state, and importing those from the chart module
 * would pull Recharts back into the initial bundle the chart is lazy to avoid.
 *
 * `traffic` and `throughput` both come from `metrics.traffic`. They are two
 * series rather than one because requests per second and bytes per second share
 * no axis — drawn together, the four lines the contract carries are unreadable at
 * any width, and unreadable at 375px in particular.
 */
export const METRIC_SERIES = ['traffic', 'throughput', 'latency', 'capacity'] as const;
export type MetricSeries = (typeof METRIC_SERIES)[number];

export type MetricUnit = 'perSecond' | 'bytesPerSecond' | 'milliseconds' | 'bytes';

export interface SeriesLine {
  /** The row's key, and the i18n key under `server.metrics.line`. */
  readonly key: string;
  /** A `var(--chart-n)` or `var(--destructive)` token, never a literal. */
  readonly color: string;
  /** Drawn as a filled area rather than a plain line. */
  readonly filled: boolean;
}

export const SERIES_LINES: Readonly<Record<MetricSeries, readonly SeriesLine[]>> = {
  traffic: [
    { key: 'requests', color: 'var(--chart-1)', filled: true },
    { key: 'errors', color: 'var(--destructive)', filled: false },
  ],
  throughput: [
    { key: 'rx', color: 'var(--chart-2)', filled: false },
    { key: 'tx', color: 'var(--chart-3)', filled: false },
  ],
  latency: [{ key: 'latency', color: 'var(--chart-1)', filled: true }],
  capacity: [{ key: 'capacity', color: 'var(--chart-1)', filled: true }],
};

export const SERIES_UNITS: Readonly<Record<MetricSeries, MetricUnit>> = {
  traffic: 'perSecond',
  throughput: 'bytesPerSecond',
  latency: 'milliseconds',
  capacity: 'bytes',
};

export type MetricRow = Record<string, number | string>;

/** The series drawn from `metrics.traffic`, which the contract allows to be null. */
export function needsTraffic(series: MetricSeries): boolean {
  return series === 'traffic' || series === 'throughput';
}

export function rowsFor(metrics: ServerMetrics, series: MetricSeries): readonly MetricRow[] {
  const traffic = metrics.traffic ?? [];
  switch (series) {
    case 'traffic':
      return traffic.map((point) => ({
        t: point.t,
        requests: point.requestsPerSec,
        errors: point.errorsPerSec,
      }));
    case 'throughput':
      return traffic.map((point) => ({
        t: point.t,
        rx: point.rxBytesPerSec,
        tx: point.txBytesPerSec,
      }));
    case 'latency':
      return metrics.latency.map((point) => ({ t: point.t, latency: point.ms }));
    case 'capacity':
      return metrics.capacity.map((point) => ({ t: point.t, capacity: point.usedBytes }));
  }
}

export function pointCountFor(metrics: ServerMetrics, series: MetricSeries): number {
  const rows = rowsFor(metrics, series);
  return rows.length;
}
