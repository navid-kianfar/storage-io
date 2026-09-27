import * as React from 'react';

/**
 * Viewport gate for the shell. The concept turns the sidebar into a sheet below
 * 1024px, so that — not shadcn's default 768px — is the breakpoint.
 *
 * Written with `useSyncExternalStore` rather than `useState` + `useEffect`: the
 * viewport is external state, and subscribing to it directly means there is no
 * render with the wrong answer and no setState inside an effect.
 */
export const MOBILE_BREAKPOINT = 1024;

const QUERY = `(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`;

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

/** The server has no viewport; treat it as desktop, which is what the CSS assumes. */
function getServerSnapshot(): boolean {
  return false;
}

export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
