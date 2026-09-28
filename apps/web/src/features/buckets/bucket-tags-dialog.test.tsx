import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BucketTagsDialog } from './dialogs/BucketTagsDialog';
import { api } from '@/lib/api/client';
import { renderWithProviders } from '@/test/render';

/**
 * `PUT …/tags` replaces the whole set, and a bucket row in the list carries no
 * tags, so opening this dialog from the list showed an empty editor for a bucket
 * that already had tags. Adding one pair and saving then sent just that pair and
 * silently dropped every tag the bucket had — data loss behind a "Tags saved"
 * toast.
 *
 * For a single bucket the dialog now loads that bucket's tags first. Editing
 * several at once still starts empty: there is no one current set to show, and
 * the dialog says outright that the save replaces.
 */

const ONE = [{ serverId: 'srv-1', bucket: 'media-assets' }] as const;
const MANY = [
  { serverId: 'srv-1', bucket: 'media-assets' },
  { serverId: 'srv-1', bucket: 'app-logs' },
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BucketTagsDialog', () => {
  it('loads the existing tags when one bucket is selected', async () => {
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValue({ tags: { owner: 'media-team', tier: 'hot' } });

    renderWithProviders(
      <BucketTagsDialog open onOpenChange={() => {}} buckets={[...ONE]} />,
    );

    await waitFor(() => {
      expect(screen.getByRole('dialog').textContent).toContain('owner=media-team');
    });
    expect(screen.getByRole('dialog').textContent).toContain('tier=hot');
    expect(get).toHaveBeenCalledWith(
      '/servers/srv-1/buckets/media-assets/tags',
      undefined,
      expect.anything(),
    );
  });

  it('keeps the loaded tags in the payload when one more is added', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'get').mockResolvedValue({ tags: { owner: 'media-team' } });
    const put = vi.spyOn(api, 'put').mockResolvedValue({ tags: {} });

    renderWithProviders(
      <BucketTagsDialog open onOpenChange={() => {}} buckets={[...ONE]} />,
    );

    await waitFor(() => {
      expect(screen.getByRole('dialog').textContent).toContain('owner=media-team');
    });
    await user.type(screen.getByPlaceholderText('key'), 'tier');
    await user.type(screen.getByPlaceholderText('value'), 'hot');
    await user.click(screen.getByRole('button', { name: 'Add tag' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(put).toHaveBeenCalledWith('/servers/srv-1/buckets/media-assets/tags', {
        tags: { owner: 'media-team', tier: 'hot' },
      });
    });
  });

  it('starts empty for a multi-bucket edit, which replaces by design', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ tags: { owner: 'media-team' } });

    renderWithProviders(
      <BucketTagsDialog open onOpenChange={() => {}} buckets={[...MANY]} />,
    );

    await screen.findByRole('button', { name: 'Save' });
    expect(screen.getByRole('dialog').textContent).not.toContain('owner=media-team');
    expect(get).not.toHaveBeenCalled();
  });
});
