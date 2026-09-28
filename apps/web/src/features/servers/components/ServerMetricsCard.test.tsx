import type { ServerMetrics } from '@storage-io/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ServerMetricsCard } from './ServerMetricsCard';
import { renderWithProviders } from '@/test/render';

/**
 * The contract draws a distinction the card has to keep: `metrics.traffic` is
 * `null` when the provider has no metrics endpoint at all and `[]` when it has
 * one that simply has nothing in this range. Collapsing the two would tell an
 * operator on SeaweedFS to wait for samples that will never arrive.
 *
 * The chart itself is a lazy Recharts chunk and is not what breaks; which of the
 * four series is chosen, and which of the two empty states is shown, is.
 */

function metricsWith(traffic: ServerMetrics['traffic']): ServerMetrics {
  return {
    capacity: [],
    latency: [
      { t: '2026-09-28T10:00:00.000Z', ms: 6 },
      { t: '2026-09-28T10:00:30.000Z', ms: 8 },
    ],
    uptime: 1,
    traffic,
  };
}

const trafficPoints: ServerMetrics['traffic'] = [
  { t: '2026-09-28T10:00:00.000Z', requestsPerSec: 4, errorsPerSec: 0, rxBytesPerSec: 0, txBytesPerSec: 12 },
  { t: '2026-09-28T10:00:30.000Z', requestsPerSec: 9, errorsPerSec: 1, rxBytesPerSec: 8, txBytesPerSec: 16 },
];

function renderCard(metrics: ServerMetrics) {
  return renderWithProviders(
    <ServerMetricsCard
      metrics={metrics}
      loading={false}
      error={null}
      range="24h"
      onRangeChange={() => {}}
    />,
  );
}

describe('ServerMetricsCard', () => {
  it('opens on Traffic when the server reports it', () => {
    renderCard(metricsWith(trafficPoints));
    expect(screen.getByRole('radio', { name: 'Traffic' })).toBeChecked();
  });

  it('opens on Response time rather than an unavailable Traffic tab', () => {
    renderCard(metricsWith(null));
    expect(screen.getByRole('radio', { name: 'Response time' })).toBeChecked();
    expect(screen.queryByText(/not available for this provider/i)).not.toBeInTheDocument();
  });

  it('says traffic is not available for the provider when it is null', async () => {
    const user = userEvent.setup();
    renderCard(metricsWith(null));

    await user.click(screen.getByRole('radio', { name: 'Traffic' }));

    expect(screen.getByText(/not available for this provider/i)).toBeInTheDocument();
  });

  it('shows the ordinary empty state when traffic is an empty series', () => {
    renderCard(metricsWith([]));
    expect(screen.getByText(/not enough samples yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/not available for this provider/i)).not.toBeInTheDocument();
  });

  it('shows the ordinary empty state for a series with no points at all', async () => {
    const user = userEvent.setup();
    renderCard(metricsWith(trafficPoints));

    await user.click(screen.getByRole('radio', { name: 'Used capacity' }));

    expect(screen.getByText(/not enough samples yet/i)).toBeInTheDocument();
  });
});
