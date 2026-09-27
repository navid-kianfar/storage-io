import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import {
  DIALOG_OWNERS,
  DIALOG_PARAM_PREFIX,
  DIALOG_SEARCH_PARAM,
  isDialogKey,
  type DialogKey,
  type DialogParams,
} from './registry';

type SearchRecord = Record<string, unknown>;

/**
 * A search param is a string, a number or a boolean. Anything else in the search
 * object is a page's own structured state and is passed through untouched rather
 * than stringified into "[object Object]".
 */
function asParamValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function toStringRecord(search: SearchRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(search)) {
    const text = asParamValue(value);
    if (text === null) continue;
    out[key] = text;
  }
  return out;
}

/** Strips every dialog-owned key, so closing a dialog leaves the page's own filters intact. */
function withoutDialogParams(search: SearchRecord): SearchRecord {
  const out: SearchRecord = {};
  for (const [key, value] of Object.entries(search)) {
    if (key === DIALOG_SEARCH_PARAM) continue;
    if (key.startsWith(DIALOG_PARAM_PREFIX)) continue;
    out[key] = value;
  }
  return out;
}

export interface DialogsApi {
  /** The dialog the URL currently asks for, or null. */
  readonly openKey: DialogKey | null;
  /** That dialog's `d_` params, prefix stripped. */
  readonly params: DialogParams;
  /** Navigates to the dialog's owning route and opens it. */
  open: (key: DialogKey, params?: DialogParams) => void;
  /** Opens a dialog on the current route, for a dialog the page itself owns. */
  openHere: (key: DialogKey, params?: DialogParams) => void;
  close: () => void;
}

export function useDialogs(): DialogsApi {
  const navigate = useNavigate();
  const search: SearchRecord = useRouterState({ select: (state) => state.location.search });
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const requested = search[DIALOG_SEARCH_PARAM];
  const openKey: DialogKey | null =
    typeof requested === 'string' && isDialogKey(requested) ? requested : null;

  const params = useMemo<DialogParams>(() => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(search)) {
      if (!key.startsWith(DIALOG_PARAM_PREFIX)) continue;
      const text = asParamValue(value);
      if (text === null) continue;
      out[key.slice(DIALOG_PARAM_PREFIX.length)] = text;
    }
    return out;
  }, [search]);

  const openAt = useCallback(
    (to: string, key: DialogKey, dialogParams?: DialogParams) => {
      const next: SearchRecord = { ...withoutDialogParams(search), [DIALOG_SEARCH_PARAM]: key };
      for (const [name, value] of Object.entries(dialogParams ?? {})) {
        next[`${DIALOG_PARAM_PREFIX}${name}`] = value;
      }
      void navigate({ to, search: toStringRecord(next) });
    },
    [navigate, search],
  );

  const open = useCallback(
    (key: DialogKey, dialogParams?: DialogParams) => openAt(DIALOG_OWNERS[key], key, dialogParams),
    [openAt],
  );

  const openHere = useCallback(
    (key: DialogKey, dialogParams?: DialogParams) => openAt(pathname, key, dialogParams),
    [openAt, pathname],
  );

  const close = useCallback(() => {
    void navigate({
      to: pathname,
      search: toStringRecord(withoutDialogParams(search)),
      replace: true,
    });
  }, [navigate, pathname, search]);

  return { openKey, params, open, openHere, close };
}
