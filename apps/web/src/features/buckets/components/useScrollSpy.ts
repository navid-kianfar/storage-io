import { useEffect, useState } from 'react';

/**
 * Which anchored section is currently in view, for the settings page's sub-nav.
 *
 * An IntersectionObserver rather than a scroll listener: the browser does the
 * work off the main thread, and there is no `scroll` handler firing dozens of
 * times a second while the operator drags the scrollbar.
 *
 * `rootMargin` pulls the top of the viewport down past the sticky topbar, so a
 * section counts as current once its heading is actually visible. The last
 * intersecting section wins when several are on screen, which is what the eye
 * agrees with when a short section sits above a long one.
 */
export function useScrollSpy(
  ids: readonly string[],
  { topOffset = 120 }: { readonly topOffset?: number } = {},
): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);

  useEffect(() => {
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return;

    const visible = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // Keep the declared order rather than the order the entries arrived in.
        const firstVisible = ids.find((id) => visible.has(id));
        if (firstVisible !== undefined) setActive(firstVisible);
      },
      { rootMargin: `-${String(topOffset)}px 0px -55% 0px`, threshold: 0 },
    );

    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [ids, topOffset]);

  return active;
}
