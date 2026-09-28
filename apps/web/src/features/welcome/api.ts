import type { Settings, UpdateSettingsRequest } from '@storage-io/contracts';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * The first-run wizard's one write outside `/servers`: the region preferences it
 * collects. `PATCH /settings` takes a partial tree, so this sends only the
 * `region` section and leaves everything else the API already holds.
 *
 * It lives here rather than in `features/settings` because the Settings page owns
 * that module; when the two meet, this is the call site to move.
 */
export function useUpdateSettings(): UseMutationResult<Settings, Error, UpdateSettingsRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSettingsRequest) => api.patch<Settings>('/settings', body),
    onSuccess: (settings) => {
      // The shell reads this query for every formatter, so seeding it means the
      // units and calendar change without a round trip.
      queryClient.setQueryData(queryKeys.settings.current(), settings);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    },
  });
}
