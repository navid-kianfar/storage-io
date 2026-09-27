import type { Notification } from '@storage-io/contracts';
import { PanelLeftIcon, SearchIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Breadcrumbs } from '@/components/shell/Breadcrumbs';
import { NotificationsPopover } from '@/components/shell/NotificationsPopover';
import { LanguageMenu, ThemeMenu } from '@/components/shell/ThemeMenu';
import { TransfersPopover } from '@/components/shell/TransfersPopover';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { useSidebar } from '@/components/ui/sidebar';
import { isMacPlatform } from '@/lib/platform';

/**
 * The sticky top bar from the concept: the mobile sidebar trigger, breadcrumbs,
 * the search trigger with its ⌘K hint, transfers, notifications, then the language
 * and theme menus.
 */
export function Topbar({
  notifications,
  unread,
  notificationsLoading,
  onMarkAllRead,
  markingAllRead,
  onOpenCommandPalette,
}: {
  readonly notifications: readonly Notification[];
  readonly unread: number;
  readonly notificationsLoading: boolean;
  readonly onMarkAllRead: () => void;
  readonly markingAllRead: boolean;
  readonly onOpenCommandPalette: () => void;
}) {
  const { t } = useTranslation('nav');
  const { toggleSidebar, isMobile } = useSidebar();

  return (
    <header className="sticky top-0 z-20 flex h-(--topbar-h) items-center gap-1.5 border-b bg-background/85 px-4 backdrop-blur-md backdrop-saturate-150">
      {isMobile ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label={t('topbar.toggleSidebar')}
        >
          <PanelLeftIcon />
        </Button>
      ) : null}

      <Breadcrumbs />

      <button
        type="button"
        onClick={onOpenCommandPalette}
        className="ms-auto flex h-[calc(var(--control-h)-0.125rem)] items-center gap-2 rounded-md border border-input bg-muted px-2.5 text-[0.8125rem] text-muted-foreground hover:border-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none lg:w-68"
      >
        <SearchIcon className="size-4" />
        <span className="hidden lg:inline">{t('topbar.searchTrigger')}</span>
        <Kbd className="ms-auto hidden lg:inline-flex">{isMacPlatform() ? '⌘K' : 'Ctrl K'}</Kbd>
      </button>

      <TransfersPopover />
      <NotificationsPopover
        notifications={notifications}
        unread={unread}
        loading={notificationsLoading}
        onMarkAllRead={onMarkAllRead}
        markingAllRead={markingAllRead}
      />
      {/*
        The height override has to carry the same variant as the class it beats:
        Separator sets `data-[orientation=vertical]:h-full`, and a plain `h-5` is a
        different key to tailwind-merge, so both would survive and the full-height
        one would win.
      */}
      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
      <LanguageMenu />
      <ThemeMenu />
    </header>
  );
}
