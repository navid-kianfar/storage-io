import { BoxesIcon, ChevronsUpDownIcon, PlusIcon, Settings2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { PROVIDER_LABELS, type Server } from '@storage-io/contracts';
import { ProviderMark } from '@/components/app/ProviderMark';
import { StatusDot, serverStatusTone } from '@/components/app/StatusBadge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The sidebar's server switcher (`.sb-server` in the concept). "All servers" is a
 * real choice, not a placeholder: the aggregated lists span every server.
 *
 * Picking a server navigates to that server's page rather than setting a hidden
 * global filter — the scope is always visible in the URL.
 */
export function ServerSwitcher({
  servers,
  loading,
  currentServerId,
}: {
  readonly servers: readonly Server[];
  readonly loading: boolean;
  readonly currentServerId: string | null;
}) {
  const { t } = useTranslation('nav');
  const navigate = useNavigate();

  const current = servers.find((server) => server.id === currentServerId);

  if (loading) {
    return (
      <div className="mx-3 mt-1 mb-2 flex items-center gap-2.5 rounded-lg border border-sidebar-border p-2">
        <Skeleton className="size-7 rounded-md" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-2.5 w-16" />
        </div>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('sidebar.serverSwitcher')}
        className={cn(
          'mx-3 mt-1 mb-2 flex items-center gap-2.5 rounded-lg border border-sidebar-border bg-sidebar-accent-bg p-2 text-start',
          'hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50 focus-visible:outline-none',
        )}
      >
        {current === undefined ? (
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-provider-generic text-white">
            <BoxesIcon className="size-4" />
          </span>
        ) : (
          <ProviderMark provider={current.provider} />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">
            {current === undefined ? t('sidebar.allServers') : current.name}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-sidebar-muted">
            {current === undefined ? (
              t('sidebar.connectedCount', { count: servers.length })
            ) : (
              <>
                <StatusDot tone={serverStatusTone(current.status)} />
                {PROVIDER_LABELS[current.provider]}
              </>
            )}
          </span>
        </span>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-sidebar-muted" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-68">
        <DropdownMenuLabel>{t('item.servers')}</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={current === undefined}
          onCheckedChange={() => void navigate({ to: '/' })}
        >
          <BoxesIcon />
          {t('sidebar.allServers')}
        </DropdownMenuCheckboxItem>
        {servers.map((server) => (
          <DropdownMenuCheckboxItem
            key={server.id}
            checked={server.id === current?.id}
            onCheckedChange={() =>
              void navigate({ to: '/servers/$serverId', params: { serverId: server.id } })
            }
          >
            <StatusDot tone={serverStatusTone(server.status)} />
            <span className="ltr-isolate flex-1 truncate font-mono">{server.name}</span>
            <span className="text-xs text-muted-foreground">
              {PROVIDER_LABELS[server.provider]}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate({ to: '/servers/new' })}>
          <PlusIcon />
          {t('sidebar.addServer')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void navigate({ to: '/servers' })}>
          <Settings2Icon />
          {t('sidebar.manageServers')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
