import type { Settings, UpdateSettingsRequest } from '@storage-io/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * The transfers page's one server request.
 *
 * Everything else on the page is browser state (`src/stores/transfers.ts`), but the
 * transfer *settings* are shared with the API's own streaming endpoints — the part
 * size it uses, the bandwidth it honours — so they live in `Settings.transfers` and
 * are patched section by section, which is what `PATCH /settings` accepts.
 */
export function useUpdateTransferSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (transfers: Partial<Settings['transfers']>) =>
      api.patch<Settings>('/settings', { transfers } satisfies UpdateSettingsRequest),
    onSuccess: (updated) => {
      // The response is the whole settings tree, so seed the cache rather than
      // refetching what was just returned.
      client.setQueryData(queryKeys.settings.current(), updated);
    },
  });
}
