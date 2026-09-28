import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getDialog, subscribeDialogs } from '@/lib/dialogs/registry';
import { useDialogs } from '@/lib/dialogs/useDialogs';

/**
 * Renders whichever URL-addressable dialog `?dialog=` names. Mounted once, inside
 * the app shell, so every route gets it.
 *
 * Two things make this less trivial than it looks.
 *
 * First, the component that owns a key registers itself at module scope, and that
 * module belongs to a lazily loaded route. Opening a dialog from the palette
 * therefore changes the URL *before* the chunk exists. The host subscribes to the
 * registry so a registration that lands a moment later re-renders it — without
 * that, the host concluded on its first render that the key was unregistered and
 * stripped `?dialog=` from the URL, and every palette action did nothing.
 *
 * Second, a key that genuinely never registers is a wiring mistake and must not be
 * silent. So the param is still dropped — just after a grace period long enough for
 * a route chunk to arrive, and the error still names what to fix.
 */

/** Long enough for a lazy route chunk on a slow connection, short enough to notice. */
const REGISTRATION_GRACE_MS = 2000;

export function DialogHost() {
  const { openKey, params, close } = useDialogs();

  const subscribe = useCallback((listener: () => void) => subscribeDialogs(listener), []);
  const getSnapshot = useCallback(
    () => (openKey === null ? undefined : getDialog(openKey)),
    [openKey],
  );
  const Dialog = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const missing = openKey !== null && Dialog === undefined;

  useEffect(() => {
    if (!missing) return;
    const timer = window.setTimeout(() => {
      if (import.meta.env.DEV) {
        // A wiring mistake must be impossible to miss while developing.
        console.error(
          `[dialogs] "${String(openKey)}" is in DIALOG_KEYS but no component registered it. ` +
            `Call registerDialog('${String(openKey)}', …) in the module that owns it, and check ` +
            `DIALOG_OWNERS points at the route that loads that module.`,
        );
      }
      close();
    }, REGISTRATION_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [missing, openKey, close]);

  if (openKey === null || Dialog === undefined) return null;
  // `Dialog` is a component registered once at module scope, looked up by key — not
  // a component defined during this render, which is what the rule guards against.
  // eslint-disable-next-line react-hooks/static-components
  return <Dialog params={params} onClose={close} />;
}
