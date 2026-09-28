import { emptyCapabilityMap, type CheckResult } from '@storage-io/contracts';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ServerChecks } from './ServerChecks';
import { renderWithProviders } from '@/test/render';

/**
 * The verification list is the one thing standing between a wrong endpoint and a
 * stored connection, so the three states it can be in are each asserted: running,
 * finished, and finished with a failure. The capabilities strip must not appear
 * while the run is in flight — a half-probed capability map would be a lie.
 */

const CHECKS: readonly CheckResult[] = [
  { id: 'dns', label: 'DNS & TCP reachability', status: 'ok', detail: '4 ms', durationMs: 4 },
  {
    id: 'admin',
    label: 'Admin API',
    status: 'fail',
    detail: 'Signature does not match',
    durationMs: 61,
  },
];

describe('ServerChecks', () => {
  it('shows a pending list with no capabilities while the run is in flight', () => {
    renderWithProviders(<ServerChecks checks={undefined} running capabilities={emptyCapabilityMap()} />);
    expect(screen.queryByText('Capabilities detected')).not.toBeInTheDocument();
  });

  it("keeps a failed check's own detail, which is the actual error text", () => {
    renderWithProviders(<ServerChecks checks={CHECKS} running={false} />);
    expect(screen.getByText('Admin API')).toBeInTheDocument();
    expect(screen.getByText('Signature does not match')).toBeInTheDocument();
  });

  it('names the status of every row for assistive tech, not only by colour', () => {
    renderWithProviders(<ServerChecks checks={CHECKS} running={false} />);
    expect(screen.getByText('passed')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('splits the capability strip into supported and unsupported once the run finishes', () => {
    const capabilities = { ...emptyCapabilityMap(), objects: 'supported' as const };
    renderWithProviders(
      <ServerChecks
        checks={CHECKS}
        running={false}
        capabilities={capabilities}
        version="RELEASE.2026-08-14"
        bucketCount={42}
      />,
    );
    expect(screen.getByText('Capabilities detected')).toBeInTheDocument();
    expect(screen.getByText('RELEASE.2026-08-14')).toBeInTheDocument();
    // `objects` is supported, `versioning` is not: both are listed, so the operator
    // learns what this endpoint cannot do as well as what it can.
    expect(screen.getByText('Buckets & objects')).toBeInTheDocument();
    expect(screen.getByText('Versioning')).toBeInTheDocument();
  });

  it('reports a transport failure separately from a failing check', () => {
    renderWithProviders(
      <ServerChecks checks={undefined} running={false} error="The API could not be reached." />,
    );
    expect(screen.getByText('The connection test could not run')).toBeInTheDocument();
    expect(screen.getByText('The API could not be reached.')).toBeInTheDocument();
  });
});
