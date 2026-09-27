import { useEffect } from 'react';
import { getDialog } from '@/lib/dialogs/registry';
import { useDialogs } from '@/lib/dialogs/useDialogs';

/**
 * Renders whichever URL-addressable dialog `?dialog=` names. Mounted once, inside
 * the app shell, so every route gets it.
 *
 * An unregistered key is a wiring mistake, not a user-facing state: in
 * development it is reported loudly on the console and the param is dropped; in a
 * production build it is dropped silently rather than leaving a dead `?dialog=`
 * in the address bar.
 */
export function DialogHost() {
  const { openKey, params, close } = useDialogs();
  const Dialog = openKey === null ? undefined : getDialog(openKey);
  const missing = openKey !== null && Dialog === undefined;

  useEffect(() => {
    if (!missing) return;
    if (import.meta.env.DEV) {
      // A wiring mistake must be impossible to miss while developing.
      console.error(
        `[dialogs] "${String(openKey)}" is in DIALOG_KEYS but no component registered it. ` +
          `Call registerDialog('${String(openKey)}', …) in the module that owns it, and check ` +
          `DIALOG_OWNERS points at the route that loads that module.`,
      );
    }
    close();
  }, [missing, openKey, close]);

  if (openKey === null || Dialog === undefined) return null;
  // `Dialog` is a component registered once at module scope, looked up by key — not
  // a component defined during this render, which is what the rule guards against.
  // eslint-disable-next-line react-hooks/static-components
  return <Dialog params={params} onClose={close} />;
}
