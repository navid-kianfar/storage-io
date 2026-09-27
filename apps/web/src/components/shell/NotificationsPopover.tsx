import type { Notification, NotificationLevel } from '@storage-io/contracts';
import { Link } from '@tanstack/react-router';
import { BellIcon, CircleXIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RelativeTime } from '@/components/app/Format';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** The unread count is a badge, not a number to read aloud; over 9 it becomes "9+". */
const MAX_BADGE_COUNT = 9;

const LEVEL_ICONS: Readonly<Record<NotificationLevel, typeof InfoIcon>> = {
  info: InfoIcon,
  warning: TriangleAlertIcon,
  error: CircleXIcon,
};

const LEVEL_COLORS: Readonly<Record<NotificationLevel, string>> = {
  info: 'text-info',
  warning: 'text-warning',
  error: 'text-destructive',
};

export function NotificationsPopover({
  notifications,
  unread,
  loading,
  onMarkAllRead,
  markingAllRead,
}: {
  readonly notifications: readonly Notification[];
  readonly unread: number;
  readonly loading: boolean;
  readonly onMarkAllRead: () => void;
  readonly markingAllRead: boolean;
}) {
  const { t } = useTranslation('nav');

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative"
              aria-label={
                unread > 0
                  ? `${t('topbar.notifications')} — ${t('topbar.unreadCount', { count: unread })}`
                  : t('topbar.notifications')
              }
            >
              <BellIcon />
              {unread > 0 ? (
                <span className="num absolute top-0.5 end-0 grid min-w-4 place-items-center rounded-full border-2 border-background bg-destructive px-0.5 font-mono text-[0.5625rem] leading-3 font-semibold text-white">
                  {unread > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : unread}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('topbar.notifications')}</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-88 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">{t('notifications.title')}</span>
          <Button
            variant="link"
            size="sm"
            disabled={unread === 0 || markingAllRead}
            onClick={onMarkAllRead}
          >
            {t('notifications.markAllRead')}
          </Button>
        </div>

        <ScrollArea className="max-h-80">
          {loading ? (
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          ) : notifications.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('notifications.empty')}
            </p>
          ) : (
            <ul>
              {notifications.map((notification) => {
                const Icon = LEVEL_ICONS[notification.level];
                const body = (
                  <>
                    <Icon
                      className={cn('mt-0.5 size-4 shrink-0', LEVEL_COLORS[notification.level])}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium">{notification.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {notification.detail} · <RelativeTime value={notification.at} />
                      </span>
                    </span>
                    {notification.read ? null : (
                      <span
                        aria-hidden="true"
                        className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                      />
                    )}
                  </>
                );
                return (
                  <li key={notification.id} className="border-t first:border-t-0">
                    {notification.href === null ? (
                      <div className="flex items-start gap-3 px-4 py-3">{body}</div>
                    ) : (
                      <Link
                        to={notification.href}
                        className="flex items-start gap-3 px-4 py-3 hover:bg-accent"
                      >
                        {body}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>

        <div className="border-t p-2">
          <Button variant="ghost" size="sm" className="w-full" asChild>
            <Link to="/activity">{t('notifications.viewActivity')}</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
