import type { Dashboard, Server } from '@storage-io/contracts';
import { Link, useRouterState } from '@tanstack/react-router';
import {
  CommandIcon,
  EllipsisVerticalIcon,
  KeyboardIcon,
  LogOutIcon,
  UserRoundCogIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Bytes, Pct } from '@/components/app/Format';
import { Meter } from '@/components/app/Meter';
import { Logo } from '@/components/shell/Logo';
import { ServerSwitcher } from '@/components/shell/ServerSwitcher';
import { NAV_GROUPS, type NavCount } from '@/components/shell/navigation';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

/**
 * The sidebar from the concept: brand + version, server switcher, four nav groups
 * with live counts, the storage-used card, and the admin menu.
 *
 * It renders whatever data it is given and fetches nothing, so it is the same
 * component in a test, in Storybook and in the app.
 */

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.1.0';

function countsFrom(dashboard: Dashboard | undefined): Readonly<Record<NavCount, number | null>> {
  if (dashboard === undefined) {
    return { servers: null, buckets: null, users: null, keys: null, activeJobs: null };
  }
  return {
    servers: dashboard.totals.servers.total,
    buckets: dashboard.totals.buckets,
    // `totals.users` / `totals.accessKeys` are the counts across every server
    // whose driver reports them. Never `expiringKeys.length`, which is the next
    // 30 days only and means something else entirely.
    users: dashboard.totals.users,
    keys: dashboard.totals.accessKeys,
    activeJobs: dashboard.jobs.length === 0 ? null : dashboard.jobs.length,
  };
}

export function AppSidebar({
  servers,
  serversLoading,
  dashboard,
  displayName,
  email,
  onSignOut,
  onOpenCommandPalette,
}: {
  readonly servers: readonly Server[];
  readonly serversLoading: boolean;
  readonly dashboard: Dashboard | undefined;
  readonly displayName: string;
  readonly email: string | null;
  readonly onSignOut: () => void;
  readonly onOpenCommandPalette: () => void;
}) {
  const { t } = useTranslation('nav');
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const counts = countsFrom(dashboard);

  const usedBytes = dashboard?.totals.usedBytes ?? null;
  const capacityBytes = dashboard?.totals.capacityBytes ?? null;
  const usedRatio =
    usedBytes !== null && capacityBytes !== null && capacityBytes > 0
      ? usedBytes / capacityBytes
      : null;

  const currentServerId = matchServerParam(pathname);
  const initials = initialsOf(displayName);

  return (
    <Sidebar side="left" collapsible="offcanvas" aria-label={t('sidebar.label')}>
      <SidebarHeader className="p-0">
        <Link
          to="/"
          className="flex h-(--topbar-h) items-center gap-2.5 px-4 text-[0.9375rem] font-bold tracking-[-0.02em]"
        >
          <Logo />
          <span>storage-io</span>
          <span className="ms-auto font-mono text-[0.6875rem] font-medium text-sidebar-muted">
            v{APP_VERSION}
          </span>
        </Link>
        <ServerSwitcher
          servers={servers}
          loading={serversLoading}
          currentServerId={currentServerId}
        />
      </SidebarHeader>

      <SidebarContent className="px-3">
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.labelKey} className="p-0">
            <SidebarGroupLabel className="px-2 text-[0.6875rem] font-semibold tracking-[0.06em] text-sidebar-muted uppercase">
              {t(`group.${group.labelKey}`)}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const active = isActivePath(pathname, item.to);
                  const count = item.count === undefined ? null : counts[item.count];
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        className={cn(
                          'h-8 text-[0.8125rem] font-medium',
                          'data-[active=true]:bg-sidebar-active-bg data-[active=true]:text-sidebar-active-fg data-[active=true]:shadow-sm',
                          'data-[active=true]:[&>svg]:text-sidebar-primary',
                          '[&>svg]:text-sidebar-muted',
                        )}
                      >
                        <Link to={item.to}>
                          <item.icon />
                          <span>{t(`item.${item.labelKey}`)}</span>
                        </Link>
                      </SidebarMenuButton>
                      {count === null ? null : (
                        <SidebarMenuBadge
                          className={cn(
                            'num font-mono text-[0.6875rem]',
                            item.live === true ? 'text-sidebar-primary' : 'text-sidebar-muted',
                          )}
                        >
                          {count}
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="gap-3 border-t border-sidebar-border p-3">
        <div className="rounded-lg bg-sidebar-accent p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{t('sidebar.storageUsed')}</span>
            <Pct value={usedRatio} className="text-sidebar-muted" />
          </div>
          <Meter
            value={usedRatio}
            className="mt-2 bg-sidebar-border"
            label={t('sidebar.storageUsed')}
          />
          <div className="num mt-2 text-sidebar-muted">
            <Bytes value={usedBytes} /> / <Bytes value={capacityBytes} />
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-start hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50 focus-visible:outline-none">
            <Avatar className="size-8">
              <AvatarFallback className="text-xs font-semibold">{initials}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-semibold">{displayName}</span>
              {email === null ? null : (
                <span className="truncate text-xs text-sidebar-muted">{email}</span>
              )}
            </span>
            <EllipsisVerticalIcon className="size-3.5 shrink-0 text-sidebar-muted" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-60">
            {email === null ? null : <DropdownMenuLabel>{email}</DropdownMenuLabel>}
            <DropdownMenuItem asChild>
              <Link to="/settings">
                <UserRoundCogIcon />
                {t('sidebar.accountAndSecurity')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenCommandPalette}>
              <CommandIcon />
              {t('sidebar.commandPalette')}
              <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/settings" hash="shortcuts">
                <KeyboardIcon />
                {t('sidebar.keyboardShortcuts')}
                <DropdownMenuShortcut>?</DropdownMenuShortcut>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
              <LogOutIcon />
              {t('sidebar.signOut', { defaultValue: 'Sign out' })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

/** `/` only matches itself; every other item matches its own subtree. */
export function isActivePath(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** The server segment of /servers/$server, /buckets/$server/… and /browse/$server/…. */
function matchServerParam(pathname: string): string | null {
  const match = /^\/(?:servers|buckets|browse)\/([^/]+)/.exec(pathname);
  return match?.[1] ?? null;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '').charAt(0)}${(parts[1] ?? '').charAt(0)}`.toUpperCase();
}
