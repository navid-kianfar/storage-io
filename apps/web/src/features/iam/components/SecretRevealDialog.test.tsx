import type { CreatedKey } from '@storage-io/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { SecretRevealDialog } from './SecretRevealDialog';

/**
 * This dialog is a one-way door: the secret exists in the browser once and is not
 * retrievable afterwards. The tests are about the ways an operator can lose it —
 * a stray Escape, a click on the overlay, or a Done button that was never gated.
 */

const created: CreatedKey = {
  accessKey: {
    id: 'key-11111111-1111-4111-8111-111111111111',
    serverId: 'srv-1',
    serverName: 'minio-prod-01',
    provider: 'minio',
    accessKeyId: 'SIO7K2QW9XP4RM81NB3C',
    userName: 'ci-deployer',
    name: 'GitHub Actions',
    status: 'active',
    restricted: false,
    createdAt: '2026-09-28T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    rotation: null,
  },
  secretAccessKey: 'q9Zr+Lw2sYx8vT4bN1mK0pHc7eJfGd5aUoRiWtEy',
  endpoint: 'https://s3.prod.acme.local:9000',
  region: 'us-east-1',
};

function renderDialog(onDone = vi.fn()) {
  renderWithProviders(
    <SecretRevealDialog created={created} serverName="minio-prod-01" onDone={onDone} />,
  );
  return onDone;
}

describe('SecretRevealDialog', () => {
  it('shows the access key id and the secret', () => {
    renderDialog();
    expect(screen.getByText(created.accessKey.accessKeyId)).toBeInTheDocument();
    expect(screen.getByText(created.secretAccessKey)).toBeInTheDocument();
  });

  it('keeps Done disabled until the operator says they have stored it', async () => {
    const user = userEvent.setup();
    const onDone = renderDialog();

    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(done);
    expect(onDone).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox'));
    expect(done).toBeEnabled();
    await user.click(done);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('does not close on Escape, because the secret cannot be shown again', async () => {
    const user = userEvent.setup();
    const onDone = renderDialog();

    await user.keyboard('{Escape}');

    expect(screen.getByText(created.secretAccessKey)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('generates a snippet per target, with the real endpoint in it', async () => {
    const user = userEvent.setup();
    renderDialog();

    // The .env tab is the default.
    expect(screen.getByText(/AWS_ENDPOINT_URL=https:\/\/s3\.prod\.acme\.local:9000/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'MinIO mc' }));
    expect(
      screen.getByText(/mc alias set minio-prod-01 https:\/\/s3\.prod\.acme\.local:9000/),
    ).toBeInTheDocument();
  });
});
