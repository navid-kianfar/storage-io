import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_IDS,
  type SettingsSectionId,
} from '@/features/settings/sections';

/**
 * The sticky section nav, with a scroll spy.
 *
 * An IntersectionObserver rather than a scroll listener: the browser does the
 * geometry, and it does not fire sixty times a second while the operator drags the
 * scrollbar. The root margin pins the "current" section to the band just under the
 * sticky top bar, which is where an operator's eye actually is — using the plain
 * viewport would mark a section current while it is still off the top of the screen.
 *
 * Clicking a link is a normal in-page anchor, so Back works and a link to
 * `/settings#notifications` from another page lands in the right place.
 */

const TOPBAR_OFFSET = '-96px';
const BOTTOM_MARGIN = '-55%';

export function SettingsNav() {
  const { t } = useTranslation('pages');
  const [current, setCurrent] = useState<SettingsSectionId>(SETTINGS_SECTION_IDS[0]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
        const first = visible[0]?.target.id;
        if (first !== undefined) setCurrent(first as SettingsSectionId);
      },
      { rootMargin: `${TOPBAR_OFFSET} 0px ${BOTTOM_MARGIN} 0px`, threshold: 0 },
    );

    for (const section of SETTINGS_SECTIONS) {
      const element = document.getElementById(section.id);
      if (element !== null) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <nav
      aria-label={t('settings.navLabel')}
      className="sticky top-[calc(var(--topbar-h)+1rem)] hidden h-fit flex-col gap-0.5 lg:flex"
    >
      {SETTINGS_SECTIONS.map((section) => (
        <span key={section.id} className="contents">
          {section.separatorBefore ? <span className="my-1.5 h-px bg-border" /> : null}
          <a
            href={`#${section.id}`}
            aria-current={current === section.id ? 'true' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[0.8125rem] text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-foreground',
              'aria-[current=true]:bg-primary/8 aria-[current=true]:font-medium aria-[current=true]:text-primary',
            )}
          >
            <section.icon className="size-4 shrink-0" aria-hidden="true" />
            {t(`settings.section.${section.id}`)}
          </a>
        </span>
      ))}
    </nav>
  );
}
