import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { SETTINGS_SECTIONS, type SettingsSectionId } from '@/features/settings/sections';

/**
 * The section nav. Each entry is a link to `/settings/$section`, so a section is
 * an address: Back works, a bookmark works, and a notification can point at the
 * setting it is about instead of at the top of a long page.
 *
 * It was a scroll spy over anchors on one long page. That is gone with the page:
 * there is nothing to spy on when one section renders at a time, and "which
 * section am I in" is now simply what the URL says.
 *
 * Below `lg` it is a horizontally scrolling row of chips above the section rather
 * than a column beside it — a two-pane layout at 375 px is one pane and a memory
 * of another. The row scrolls inside itself, so the page never does.
 */
export function SettingsNav({ active }: { readonly active: SettingsSectionId }) {
  const { t } = useTranslation('pages');

  return (
    <nav
      aria-label={t('settings.navLabel')}
      className={cn(
        'no-scrollbar -mx-(--content-pad-inline) flex gap-1 overflow-x-auto px-(--content-pad-inline)',
        'lg:sticky lg:top-[calc(var(--topbar-h)+1rem)] lg:mx-0 lg:h-fit lg:flex-col lg:gap-0.5 lg:px-0',
      )}
    >
      {SETTINGS_SECTIONS.map((section) => (
        <span key={section.id} className="contents">
          {section.separatorBefore ? (
            <span className="my-1.5 hidden h-px bg-border lg:block" />
          ) : null}
          <Link
            to="/settings/$section"
            params={{ section: section.id }}
            aria-current={active === section.id ? 'true' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-[0.8125rem] whitespace-nowrap text-muted-foreground transition-colors',
              // 40px minimum touch target on a phone, per the responsive rules.
              'min-h-10 lg:min-h-0',
              'hover:bg-accent hover:text-foreground',
              'aria-[current=true]:bg-primary/8 aria-[current=true]:font-medium aria-[current=true]:text-primary',
            )}
          >
            <section.icon className="size-4 shrink-0" aria-hidden="true" />
            {t(`settings.section.${section.id}`)}
          </Link>
        </span>
      ))}
    </nav>
  );
}
