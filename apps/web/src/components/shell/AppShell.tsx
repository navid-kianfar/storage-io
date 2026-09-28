import { Outlet } from '@tanstack/react-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { DialogHost } from '@/components/app/DialogHost';
import { AppSidebar } from '@/components/shell/AppSidebar';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { Topbar } from '@/components/shell/Topbar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { useLogout, useMe } from '@/features/auth/api';
import {
  useDashboard,
  useMarkNotificationsRead,
  useNotifications,
  useServerList,
  useSettings,
} from '@/features/shell/api';
import { useEngineSettings } from '@/features/transfers/useEngineSettings';
import { FormatProvider } from '@/lib/format/FormatProvider';
import { useEventStream } from '@/lib/events/useEventStream';
import { hasPaletteModifier } from '@/lib/platform';

/**
 * The authenticated shell: sidebar, top bar, page outlet, the URL-addressed dialog
 * host and the command palette. It also opens the single SSE connection and feeds
 * `Settings.region` into the formatting context.
 *
 * Everything below it can assume: a session exists, formatting is configured, and
 * a dialog opened by `?dialog=` will render.
 */
export function AppShell({ children }: { readonly children?: ReactNode }) {
  const { t } = useTranslation('auth');
  const [paletteOpen, setPaletteOpen] = useState(false);

  const me = useMe();
  const servers = useServerList();
  const dashboard = useDashboard();
  const settings = useSettings();
  const notifications = useNotifications();
  const markAllRead = useMarkNotificationsRead();
  const logout = useLogout();

  useEventStream({ enabled: me.isSuccess });
  // The transfer engine outlives every page, so its settings are applied here.
  useEngineSettings();

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  // ⌘K / Ctrl-K anywhere; "/" only when the focus is not in a text field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && hasPaletteModifier(event)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const onSignOut = useCallback(() => {
    logout.mutate(undefined, {
      onSuccess: () => {
        toast.success(t('signedOut'));
        // A full reload is the cleanest way to drop every in-memory store as well
        // as the query cache, and it lands on /login through the router's guard.
        window.location.assign('/login');
      },
    });
  }, [logout, t]);

  return (
    <FormatProvider region={settings.data?.region}>
      <SidebarProvider>
        <AppSidebar
          servers={servers.data?.items ?? []}
          serversLoading={servers.isLoading}
          dashboard={dashboard.data}
          displayName={me.data?.displayName ?? me.data?.username ?? ''}
          email={me.data?.email ?? null}
          onSignOut={onSignOut}
          onOpenCommandPalette={openPalette}
        />
        <SidebarInset className="min-w-0">
          <Topbar
            notifications={notifications.data?.items ?? []}
            unread={notifications.data?.unread ?? 0}
            notificationsLoading={notifications.isLoading}
            onMarkAllRead={() => markAllRead.mutate('all')}
            onMarkNotificationRead={(id) => markAllRead.mutate([id])}
            markingAllRead={markAllRead.isPending}
            onOpenCommandPalette={openPalette}
          />
          <main
            id="content"
            className="relative isolate w-full max-w-[1640px] flex-1 px-(--content-pad-inline) pt-(--content-pad-block-start) pb-(--content-pad-block-end)"
          >
            {children ?? <Outlet />}
          </main>
        </SidebarInset>

        <DialogHost />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </SidebarProvider>
    </FormatProvider>
  );
}

/** "/" must reach the palette from a table, but not from a search box. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
