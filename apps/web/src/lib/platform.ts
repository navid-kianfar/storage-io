/**
 * Whether to show ⌘ or Ctrl in a shortcut hint. `navigator.platform` is
 * deprecated but `userAgentData` is not in every browser this runs in, so both are
 * consulted and the answer is cached — it cannot change mid-session.
 */
let cached: boolean | null = null;

export function isMacPlatform(): boolean {
  if (cached !== null) return cached;
  if (typeof navigator === 'undefined') {
    cached = false;
    return cached;
  }
  const withData = navigator as Navigator & {
    readonly userAgentData?: { readonly platform?: string };
  };
  const platform = withData.userAgentData?.platform ?? navigator.platform ?? '';
  cached = /mac/i.test(platform);
  return cached;
}

/** True for the platform's "command palette" modifier on this event. */
export function hasPaletteModifier(event: KeyboardEvent): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}
