import { SETTINGS_DEFAULTS, type Settings } from '@storage-io/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationsSection } from './sections/NotificationsSection';
import { api } from '@/lib/api/client';
import { renderWithProviders } from '@/test/render';

/**
 * Two regressions on the notification channels card.
 *
 * 1. A configured channel could not be cleared. Save is disabled on an empty
 *    URL, and an omitted secret means "keep the stored one", so there was no
 *    way out of a stale webhook once one had been saved. `DELETE
 *    /settings/notifications/:channel` is the way out, and the dialog must
 *    offer it — but only for a channel that is actually configured.
 *
 * 2. At 375px the channel name overflowed its column and painted across the
 *    buttons, because every control in the row is `shrink-0` and the name's
 *    column had a zero floor, so it absorbed all the shrinking and collapsed to
 *    a couple of pixels. jsdom has no layout engine, so the structural
 *    guarantee is asserted instead: the column keeps a width floor and the name
 *    truncates rather than spilling.
 */

const withWebhook = (): Settings => {
  const base = structuredClone(SETTINGS_DEFAULTS);
  base.notifications.webhook = { enabled: true, url: 'https://hooks.example.invalid/hook' };
  return base;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('notification channels card', () => {
  it('offers Disconnect for a configured channel and calls the endpoint', async () => {
    const user = userEvent.setup();
    const settings = withWebhook();
    const remove = vi.spyOn(api, 'delete').mockResolvedValue(structuredClone(SETTINGS_DEFAULTS));

    renderWithProviders(<NotificationsSection settings={settings} loading={false} />);

    await user.click(screen.getByRole('button', { name: 'Configure' }));
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));

    // Destructive, so it asks first — the endpoint must not be called on the
    // button alone.
    expect(remove).not.toHaveBeenCalled();

    const confirm = await screen.findByRole('alertdialog');
    const confirmButton = within(confirm).getByRole('button', { name: 'Disconnect' });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith('/settings/notifications/webhook');
    });
  });

  it('offers no Disconnect for a channel that was never configured', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <NotificationsSection settings={structuredClone(SETTINGS_DEFAULTS)} loading={false} />,
    );

    // Email is at its defaults: there is nothing to disconnect.
    const connectButtons = screen.getAllByRole('button', { name: 'Connect' });
    await user.click(connectButtons[0] as HTMLElement);

    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('keeps the channel name from overflowing across the row controls', () => {
    renderWithProviders(<NotificationsSection settings={withWebhook()} loading={false} />);

    // "Webhook" also names a column in the events matrix; the one under test is
    // the channel row's name, which sits next to the row's saved summary.
    const summary = screen.getByText('https://hooks.example.invalid/hook');
    const column = summary.parentElement;
    expect(column).not.toBeNull();
    const name = within(column as HTMLElement).getByText('Webhook');
    expect(name.className).toContain('truncate');

    expect(column).not.toBeNull();
    // A floor, not `min-w-0`: with a zero floor the column collapses and the
    // name paints over the buttons at 375px.
    expect(column?.className).toContain('min-w-[8rem]');
    expect(column?.className).not.toContain('min-w-0');
  });
});
