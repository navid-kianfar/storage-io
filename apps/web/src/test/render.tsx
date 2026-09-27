import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { FormatProvider } from '@/lib/format/FormatProvider';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * Renders a kit component inside the providers it needs — formatting, tooltips and
 * a query client that never retries, so a failing request fails the test at once
 * instead of after three attempts.
 *
 * A component that needs the router is rendered by the test that needs it, with a
 * memory history: the kit itself does not depend on the router.
 */
function Providers({ children }: { readonly children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <FormatProvider>{children}</FormatProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): RenderResult {
  return render(ui, { wrapper: Providers, ...options });
}
