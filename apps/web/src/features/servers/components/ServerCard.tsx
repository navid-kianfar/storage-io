import { PROVIDER_LABELS, type Server } from '@storage-io/contracts';
import { Link } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  ConstructionIcon,
  EllipsisIcon,
  HardDriveIcon,
  KeyRoundIcon,
  LockOpenIcon,
  PanelTopOpenIcon,
  PencilIcon,
  PlugZapIcon,
  RefreshCwIcon,
  UnplugIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Bytes,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CopyField,
  Dash,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Meter,
  Ms,
  Num,
  Pct,
  ProviderMark,
  RelativeTime,
  ServerStatusBadge,
  Spinner,
  meterToneFor,
} from '@/components/app';
import { ServerStatusAlert } from '@/features/servers/components/ServerStatusAlert';

/**
 * One server, as the concept's `.server-card` draws it — including its degraded
 * and offline variants, which are not a separate card but the same one with the
 * status alert in place of the capacity line's calm reading.
 *
 * Every action in the menu is wired: the ones that need a dialog open it by URL
 * (so the palette and a bookmark reach them too), and the two that are a single
 * request — Test and Maintenance — run here and report through a toast.
 */
export interface ServerCardActions {
  readonly onTest: (server: Server) => void;
  readonly onCheck: (server: Server) => void;
  readonly onEdit: (server: Server) => void;
  readonly onRotate: (server: Server) => void;
  readonly onToggleMaintenance: (server: Server) => void;
  readonly onRemove: (server: Server) => void;
}

export function ServerCard({
  server,
  actions,
  testing,
  checking,
  maintenanceBusy,
}: {
  readonly server: Server;
  readonly actions: ServerCardActions;
  readonly testing: boolean;
  readonly checking: boolean;
  readonly maintenanceBusy: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();

  const { usedBytes, totalBytes, budget } = server.capacity;
  const ratio =
    usedBytes === null || totalBytes === null || totalBytes === 0 ? null : usedBytes / totalBytes;
  const offline = server.status === 'offline';

  return (
    <Card
      data-offline={offline}
      className="gap-0 overflow-hidden py-0 data-[offline=true]:border-destructive/30"
    >
      <CardHeader className="flex-row items-start gap-3 p-(--card-pad)">
        <ProviderMark provider={server.provider} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <Link
            to="/servers/$serverId"
            params={{ serverId: server.id }}
            className="truncate font-mono text-sm font-medium hover:underline"
          >
            {server.name}
          </Link>
          <span className="truncate text-xs text-muted-foreground">
            {PROVIDER_LABELS[server.provider]}
            {server.version === null ? null : <> · {server.version}</>}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ServerStatusBadge status={server.status} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('servers.card.actions')}>
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuLabel className="font-mono">{server.name}</DropdownMenuLabel>
              <DropdownMenuItem asChild>
                <Link to="/servers/$serverId" params={{ serverId: server.id }}>
                  <PanelTopOpenIcon />
                  {t('servers.card.open')}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.onTest(server)}>
                <PlugZapIcon />
                {t('servers.card.test')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.onEdit(server)}>
                <PencilIcon />
                {t('servers.card.editConnection')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.onRotate(server)}>
                <KeyRoundIcon />
                {t('servers.card.rotate')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={maintenanceBusy}
                onSelect={() => actions.onToggleMaintenance(server)}
              >
                <ConstructionIcon />
                {server.maintenance
                  ? t('servers.card.maintenanceOff')
                  : t('servers.card.maintenanceOn')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => actions.onRemove(server)}>
                <UnplugIcon />
                {t('servers.card.remove')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 px-(--card-pad) pb-(--card-pad)">
        <CopyField value={server.endpoint} label={t('servers.card.copyEndpoint')} />

        <ServerStatusAlert
          serverName={server.name}
          status={server.status}
          detail={server.statusDetail}
          since={server.lastSeenAt}
          note={
            offline && server.counts.buckets > 0
              ? t('servers.card.readOnlyNote', { count: server.counts.buckets })
              : undefined
          }
        />

        <div>
          <div className="flex items-center justify-between text-[0.8125rem]">
            <span className="text-muted-foreground">
              {budget ? t('servers.card.budget') : t('servers.card.capacity')}
            </span>
            <span className="num">
              <Bytes value={usedBytes} />
              {totalBytes === null ? null : (
                <>
                  {' / '}
                  <Bytes value={totalBytes} />
                </>
              )}
            </span>
          </div>
          <Meter
            value={ratio}
            tone={meterToneFor(ratio)}
            size="lg"
            className="mt-2"
            label={t('servers.card.capacityMeter', { name: server.name })}
          />
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border p-3 sm:grid-cols-4">
          <Stat label={t('servers.card.buckets')} value={<Num value={server.counts.buckets} />} />
          <Stat label={t('servers.card.users')} value={<Num value={server.counts.users} />} />
          <Stat
            label={t('servers.card.latency')}
            value={
              <Ms
                value={server.latencyMs}
                className={server.status === 'degraded' ? 'text-warning' : undefined}
              />
            }
          />
          <Stat
            label={t('servers.card.uptime')}
            value={<Pct value={server.uptime24h} fractionDigits={2} />}
          />
        </dl>

        {server.tls ? null : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LockOpenIcon className="size-3.5 text-warning" aria-hidden="true" />
            {t('servers.card.plainHttp')}
          </p>
        )}
      </CardContent>

      <CardFooter className="flex-wrap items-center gap-2 border-t px-(--card-pad) py-3">
        <span className="text-xs text-muted-foreground">
          {offline ? (
            t('servers.card.retrying', { seconds: server.options.healthIntervalSec })
          ) : server.lastCheckedAt === null ? (
            <Dash />
          ) : (
            <>
              {t('servers.card.checked')} <RelativeTime value={server.lastCheckedAt} />
            </>
          )}
        </span>
        <span className="ms-auto" />
        {offline ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => actions.onCheck(server)}
            disabled={checking}
          >
            {checking ? <Spinner /> : <RefreshCwIcon />}
            {t('servers.card.retryNow')}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => actions.onTest(server)}
            disabled={testing}
          >
            {testing ? <Spinner /> : <PlugZapIcon />}
            {tCommon('action.test')}
          </Button>
        )}
        <Button variant="outline" size="sm" asChild>
          <Link to="/servers/$serverId" params={{ serverId: server.id }}>
            {t('servers.card.open')}
            <ArrowRightIcon className="flip-rtl" />
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dd className="num text-sm font-semibold">{value}</dd>
      <dt className="text-[0.6875rem] text-muted-foreground">{label}</dt>
    </div>
  );
}

/** The concept's `.add-card`: the last cell of the grid is how a server is added. */
export function AddServerCard({ onClick }: { readonly onClick: () => void }) {
  const { t } = useTranslation('pages');
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center transition-[border-color,background-color] hover:border-primary/50 hover:bg-primary/4 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
        <HardDriveIcon className="size-5" aria-hidden="true" />
      </span>
      <span className="text-sm font-medium">{t('servers.add')}</span>
      <span className="max-w-64 text-xs text-muted-foreground">{t('servers.addHint')}</span>
    </button>
  );
}
