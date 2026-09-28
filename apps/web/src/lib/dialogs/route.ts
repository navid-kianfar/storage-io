import { useRouterState, type HistoryState } from '@tanstack/react-router';

/**
 * Dialogs that create or edit an entity are **routes** (docs/ROUTES.md): a child
 * route rendered through its parent page's `<Outlet/>`, so the page stays mounted
 * behind it, Back closes it, and a link or a bookmark opens it. Closing one
 * navigates to the parent route — never `history.back()`, which does nothing
 * useful when the dialog's URL was opened directly.
 *
 * The `?dialog=` + `d_*` registry this replaces is gone: it put entity names and
 * ids in the query string, which rule 2 forbids, and it made every dialog a
 * runtime lookup that could silently fail to register.
 */

/** What a dialog component still receives, now sourced from the route. */
export interface DialogProps {
  /**
   * The dialog's context: route params, plus any non-id context the opener put in
   * router history state (`navigate({ to, state })`). Never read from the query
   * string.
   */
  readonly params: Readonly<Record<string, string>>;
  /** Navigates to the parent route. */
  readonly onClose: () => void;
}

/**
 * Non-id context a route may be handed by whoever navigated to it — the object
 * browser's selection pre-filling the new-job wizard, the server a create dialog
 * should start on (rule 3). It is router history state, so it survives Back and
 * Forward, never appears in the URL, and is simply absent when the URL was typed
 * or bookmarked; every field is therefore optional and every reader has a
 * fallback.
 */
export interface RouteState {
  /** Pre-select a server in a create dialog. */
  readonly serverId?: string;
  /** Pre-fill a bucket (the new-job wizard's source). */
  readonly bucket?: string;
  /** Pre-fill a prefix (the new-job wizard's source filter). */
  readonly prefix?: string;
  /** The object keys explicitly selected in the object browser. */
  readonly keys?: readonly string[];
  /** The folders explicitly selected in the object browser. */
  readonly prefixes?: readonly string[];
  /** Pre-select the job type in the new-job wizard. */
  readonly type?: string;
  /** Pre-select a user (the create-access-key dialog). */
  readonly userName?: string;
  /** Pre-select a policy template (the create-policy dialog). */
  readonly template?: string;
}

/**
 * The state the current location carries. It is empty on a cold entry — a typed
 * URL, a bookmark, a reload — so every reader must have a fallback.
 */
export function useRouteState(): RouteState {
  return useRouterState({ select: (state) => state.location.state as unknown as RouteState });
}

/**
 * Names our state as what `navigate({ state })` accepts.
 *
 * TanStack's `HistoryState` is an empty interface declared in `@tanstack/history`,
 * a package this one does not depend on directly and therefore cannot augment. An
 * object whose fields are all optional fails TypeScript's weak-type check against
 * it, so the widening step here is that check — not a claim about the value.
 */
export function routeState(state: RouteState): HistoryState {
  return state as unknown as HistoryState;
}

/**
 * Which overlay route is open over the current page, and the ids it carries.
 *
 * Two shapes of dialog route exist. One is self-contained — "create a bucket",
 * "add a server" — and is simply the child route's component. The other edits a
 * row of the list behind it and needs that page's handlers (pause a job, cancel
 * it, refresh the list), so the page keeps ownership and the route only says
 * *which* overlay and *which* id. This is how the page asks.
 *
 * The params come from the deepest match rather than from `useParams`, because
 * the page calling this is the **parent** route's component: `useParams` there
 * resolves against the page's own match and never sees the child's `$jobId`.
 */
export interface RouteOverlay {
  readonly name: string | null;
  readonly params: Readonly<Record<string, string>>;
}

const NO_PARAMS: Readonly<Record<string, string>> = {};

export function useRouteOverlay(): RouteOverlay {
  return useRouterState({
    select: (state): RouteOverlay => {
      const deepest = state.matches.at(-1);
      const name = deepest?.staticData.overlay ?? null;
      if (name === null || deepest === undefined) return { name: null, params: NO_PARAMS };
      return { name, params: deepest.params };
    },
  });
}
