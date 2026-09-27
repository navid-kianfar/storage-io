import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';
import { renderWithProviders } from '@/test/render';

describe('ConfirmDialog', () => {
  it('confirms immediately when no typed value is required', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Remove server"
        description="The saved connection is forgotten."
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('keeps the action disabled until the exact value is typed', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete bucket"
        destructive
        confirmValue="media-prod"
        confirmLabel="Delete bucket"
        onConfirm={onConfirm}
      />,
    );

    const action = screen.getByRole('button', { name: 'Delete bucket' });
    expect(action).toBeDisabled();

    const input = screen.getByRole('textbox', { name: 'Confirmation' });
    await user.type(input, 'media-pro');
    expect(action).toBeDisabled();
    expect(screen.getByText('That does not match')).toBeInTheDocument();

    await user.type(input, 'd');
    expect(action).toBeEnabled();
    expect(screen.queryByText('That does not match')).not.toBeInTheDocument();

    await user.click(action);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('is case-sensitive: a near miss is still a miss', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete bucket"
        confirmValue="media-prod"
        confirmLabel="Delete bucket"
        onConfirm={vi.fn()}
      />,
    );

    await user.type(screen.getByRole('textbox', { name: 'Confirmation' }), 'MEDIA-PROD');
    expect(screen.getByRole('button', { name: 'Delete bucket' })).toBeDisabled();
  });

  it('disables both buttons while the request is in flight', () => {
    renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Empty bucket"
        confirmValue="logs-2026"
        busy
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled();
  });
});
