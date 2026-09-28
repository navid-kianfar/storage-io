import type { Server } from '@storage-io/contracts';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ServerConnectionTab } from './components/ServerConnectionTab';
import { renderWithProviders } from '@/test/render';

/**
 * The page header's "Remove server" menu item is destructive and carries a bin
 * icon, but the control it needs — the danger zone — lives at the bottom of the
 * Connection tab. Switching to that tab was all the item did, leaving the
 * operator at the top of a long form with nothing visibly changed, so the item
 * read as broken.
 *
 * It now asks the tab to open the confirmation, and the tab clears the request
 * as soon as it has: without that, closing the dialog would land back on a
 * still-set `?dialog=remove` and reopen it immediately.
 */

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

const SERVER: Server = {
  id: 'srv-1',
  name: 'minio-lab',
  provider: 'minio',
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  status: 'healthy',
  statusDetail: null,
  latencyMs: 4,
  lastCheckedAt: '2026-09-28T12:00:00.000Z',
  lastSeenAt: '2026-09-28T12:00:00.000Z',
  version: null,
  uptime24h: 1,
  capacity: { usedBytes: null, totalBytes: null, budget: false },
  counts: { buckets: 3, users: 2, objects: 10 },
  capabilities: {} as Server['capabilities'],
  options: {
    pathStyle: true,
    tlsVerify: true,
    caPem: null,
    adminEndpoint: null,
    iamEndpoint: null,
    healthIntervalSec: 30,
  },
  accessKeyId: 'key',
  secretMasked: '••••',
  maintenance: false,
  tls: false,
  createdAt: '2026-09-28T10:00:00.000Z',
};

describe('ServerConnectionTab remove request', () => {
  it('opens the remove confirmation when the header asks for it', async () => {
    const onRemoveHandled = vi.fn();
    renderWithProviders(
      <ServerConnectionTab server={SERVER} removeRequested onRemoveHandled={onRemoveHandled} />,
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    // The request is consumed, so closing the dialog cannot reopen it.
    await waitFor(() => {
      expect(onRemoveHandled).not.toHaveBeenCalled(); // cleared when the dialog closes
    });
  });

  it('stays closed when nothing asked for it', () => {
    renderWithProviders(<ServerConnectionTab server={SERVER} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
