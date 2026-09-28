import { useEffect } from 'react';
import { useSettings } from '@/features/shell/api';
import { configureEngine } from './engine';

/**
 * Feeds `Settings.transfers` into the transfer engine.
 *
 * The engine is a module singleton that outlives every page, and an upload can be
 * started from the object browser or the command palette without /transfers ever
 * being opened — so the settings have to be applied from the shell rather than from
 * the page that happens to display them.
 */
export function useEngineSettings(): void {
  const settings = useSettings();
  const transfers = settings.data?.transfers;

  useEffect(() => {
    if (transfers === undefined) return;
    configureEngine({
      parallel: transfers.parallel,
      bandwidthLimitMbps: transfers.bandwidthLimitMbps,
      retries: transfers.retries,
      partSizeMb: transfers.partSizeMb,
    });
  }, [transfers]);
}
