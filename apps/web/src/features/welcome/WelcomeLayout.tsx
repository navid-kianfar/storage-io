import { Outlet } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Logo } from '@/components/shell/Logo';
import { LanguageMenu, ThemeMenu } from '@/components/shell/ThemeMenu';
import { useSettings } from '@/features/shell/api';
import { FormatProvider } from '@/lib/format/FormatProvider';

/**
 * The first-run chrome: a logo bar and the wizard, centred — the concept's
 * `setup.html`, which sets `data-shell="none"`.
 *
 * It is deliberately *not* the app shell. On first run there are no servers, no
 * buckets and no jobs, so a sidebar of empty sections and a topbar of disabled
 * actions is a menu of things that do not work yet. The page is still behind the
 * session guard — this is a layout, not a public route.
 *
 * `FormatProvider` is here because the wizard's preferences step previews sizes and
 * dates as it changes them, and that preview has to use the same formatter the rest
 * of the app will.
 */
export function WelcomeLayout() {
  const { t } = useTranslation();
  const settings = useSettings();

  return (
    <FormatProvider region={settings.data?.region}>
      <div className="flex min-h-svh flex-col">
        <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 border-b px-4">
          <Logo tileFill="var(--primary)" strokeColor="var(--primary-foreground)" />
          <span className="text-sm font-semibold">{t('app.name')}</span>
          <div className="ms-auto flex items-center gap-1">
            <LanguageMenu />
            <ThemeMenu />
          </div>
        </header>

        <main
          id="content"
          className="flex w-full flex-1 justify-center px-(--content-pad-inline) pt-(--content-pad-block-start) pb-(--content-pad-block-end)"
        >
          <Outlet />
        </main>
      </div>
    </FormatProvider>
  );
}
