import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ServerStatusAlert } from './ServerStatusAlert';
import { renderWithProviders } from '@/test/render';

/**
 * The same banner appears on the dashboard, on a server card and on the server's
 * own page, so "unreachable" has to read identically in all three. It also has to
 * render *nothing* for a healthy server: every caller passes its status
 * unconditionally rather than branching around it.
 */
describe('ServerStatusAlert', () => {
  it('renders nothing for a healthy server', () => {
    renderWithProviders(
      <ServerStatusAlert serverName="minio-prod-01" status="healthy" detail={null} since={null} />,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders nothing for an unknown status, which is not an incident', () => {
    renderWithProviders(
      <ServerStatusAlert serverName="minio-prod-01" status="unknown" detail={null} since={null} />,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("names the server and shows the API's own detail when offline", () => {
    renderWithProviders(
      <ServerStatusAlert
        serverName="garage-edge"
        status="offline"
        detail="Connection refused on port 3900"
        since={new Date(Date.now() - 840_000).toISOString()}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('garage-edge');
    expect(alert).toHaveTextContent('is unreachable');
    expect(alert).toHaveTextContent('Connection refused on port 3900');
    expect(alert).toHaveTextContent('Last seen');
  });

  it('reads as a warning rather than a failure when degraded', () => {
    renderWithProviders(
      <ServerStatusAlert
        serverName="ceph-lab"
        status="degraded"
        detail="Latency above 150 ms"
        since={null}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('is degraded');
  });

  it('renders the actions the caller passes, so Retry lives with the incident', () => {
    renderWithProviders(
      <ServerStatusAlert
        serverName="garage-edge"
        status="offline"
        detail={null}
        since={null}
        actions={<button type="button">Retry now</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
  });
});
