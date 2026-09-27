import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import { initI18n } from '@/i18n';
import { createQueryClient } from '@/lib/query/queryClient';
import { applyUrlPreferenceOverrides, usePreferences } from '@/stores/preferences';
import '@/styles/globals.css';

/**
 * Entry point. `?theme=` / `?lang=` overrides are applied before the first render
 * so they agree with the pre-paint script in index.html, and the MSW mocks start
 * before React when VITE_MOCK_API=1.
 */
async function start(): Promise<void> {
  applyUrlPreferenceOverrides(window.location.search);
  initI18n(usePreferences.getState().language);

  if (import.meta.env.VITE_MOCK_API === '1') {
    const { startMockApi } = await import('@/mocks/browser');
    await startMockApi();
  }

  const container = document.querySelector('#root');
  if (container === null) throw new Error('#root is missing from index.html');

  createRoot(container).render(
    <StrictMode>
      <App queryClient={createQueryClient()} />
    </StrictMode>,
  );
}

void start();
