import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useApplyPreferences } from '@/hooks/useApplyPreferences';
import { setUploadCompletedHandler } from '@/features/transfers/engine';
import { setUnauthorizedHandler } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';
import { createAppRouter } from '@/app/router';

/**
 * Providers, in the order they have to be:
 *
 * QueryClient → preferences applied to <html> → Tooltip → Router → Toaster.
 *
 * `setUnauthorizedHandler` is wired here rather than inside the API client so the
 * client stays free of router imports: any 401, from any request, sends the
 * operator to /login with the address they were on.
 *
 * `setUploadCompletedHandler` is wired here for the same reason in reverse: the
 * transfer engine moves bytes and must not know about the query cache, but a
 * finished upload changes what a listing returns and no SSE event reports an
 * object write — so the invalidation lives here, where both are in scope.
 */
export function App({ queryClient }: { readonly queryClient: QueryClient }) {
  const router = useMemo(() => createAppRouter(queryClient), [queryClient]);

  useApplyPreferences();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      const current = router.state.location;
      if (current.pathname === '/login') return;
      void router.navigate({
        to: '/login',
        search: { redirect: current.href },
        replace: true,
      });
    });
    return () => setUnauthorizedHandler(() => {});
  }, [router]);

  useEffect(() => {
    setUploadCompletedHandler((scope) => {
      // The listing of the folder it landed in, and the bucket's own size and
      // quota — all of them are now one object out of date.
      void queryClient.invalidateQueries({ queryKey: queryKeys.objects.all });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.buckets.detail(scope.serverId, scope.bucket),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.quotas.all });
    });
    return () => setUploadCompletedHandler(() => {});
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
