import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useApplyPreferences } from '@/hooks/useApplyPreferences';
import { setUnauthorizedHandler } from '@/lib/api/client';
import { createAppRouter } from '@/app/router';

/**
 * Providers, in the order they have to be:
 *
 * QueryClient → preferences applied to <html> → Tooltip → Router → Toaster.
 *
 * `setUnauthorizedHandler` is wired here rather than inside the API client so the
 * client stays free of router imports: any 401, from any request, sends the
 * operator to /login with the address they were on.
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

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
