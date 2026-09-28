import { PROVIDER_LABELS, type MetricRange, type Server } from '@storage-io/contracts';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ConstructionIcon,
  DatabaseIcon,
  EllipsisIcon,
  FilesIcon,
  HardDriveIcon,
  KeyRoundIcon,
  PencilIcon,
  PlugZapIcon,
  RefreshCwIcon,
  ServerIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Bytes,
  Button,
  Dash,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  KpiCard,
  Meter,
  MeterStack,
  Num,
  Pct,
  ProviderMark,
  ServerStatusBadge,
  Skeleton,
  Sparkline,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  meterToneFor,
} from '@/components/app';
import { ServerBucketsTab } from '@/features/servers/components/ServerBucketsTab';
import { ServerCapabilitiesTab } from '@/features/servers/components/ServerCapabilitiesTab';
import { ServerConnectionTab } from '@/features/servers/components/ServerConnectionTab';
import { ServerHealthCard } from '@/features/servers/components/ServerHealthCard';
import { ServerMetricsCard } from '@/features/servers/components/ServerMetricsCard';
import { ServerNodesCard } from '@/features/servers/components/ServerNodesCard';
import { ServerStatusAlert } from '@/features/servers/components/ServerStatusAlert';
import { ServerUsersTab } from '@/features/servers/components/ServerUsersTab';
import {
  useCheckServer,
  useServer,
  useServerMetrics,
  useSetMaintenance,
  useTestServer,
} from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { useDialogs } from '@/lib/dialogs/useDialogs';
import { useFormat } from '@/lib/format/FormatProvider';

/** The route owns the rotate dialog too, so its key resolves on a deep link here. */
import '@/features/servers/dialogs/RotateCredentialsDialog';

/**
 * One server, in five tabs. The tab and the metric range live in the URL, so a
 * link can point at "this server's capabilities" or "its latency over 30 days".
 *
 * The overview's numbers all come from the server object and its metrics; nothing
 * is computed from a guess. Where a provider cannot report something — nodes, S3
 * users — the tab says so rather than drawing an empty card.
 */

const TABS = ['overview', 'buckets', 'users', 'connection', 'capabilities'] as const;
type ServerTab = (typeof TABS)[number];

const RANGES: readonly MetricRange[] = ['24h', '7d', '30d'];

function isServerTab(value: unknown): value is ServerTab {
  return typeof value === 'string' && (TABS as readonly string[]).includes(value);
}

function isRange(value: unknown): value is MetricRange {
  return typeof value === 'string' && RANGES.includes(value as MetricRange);
}

export function ServerDetailPage() {
  const { t } = useTranslation('pages');
  const navigate = useNavigate();
  const dialogs = useDialogs();
  const apiError = useApiError();

  const { server: serverParam } = useParams({ from: '/protected/servers/$server' });
  const search = useSearch({ strict: false });
  const tab: ServerTab = isServerTab(search.tab) ? search.tab : 'overview';
  const range: MetricRange = isRange(search.range) ? search.range : '24h';

  const server = useServer(serverParam);
  const metrics = useServerMetrics(serverParam, range);
  const test = useTestServer();
  const check = useCheckServer();
  const maintenance = useSetMaintenance();

  const setSearch = useCallback(
    (next: Record<string, string>) => {
      void navigate({
        to: '/servers/$server',
        params: { server: serverParam },
        search: (current: Record<string, unknown>) => ({ ...current, ...next }),
        replace: true,
      });
    },
    [navigate, serverParam],
  );

  const runTest = useCallback(() => {
    if (server.data === undefined) return;
    test.mutate(server.data.id, {
      onSuccess: (response) => {
        const failed = response.checks.filter((entry) => entry.status === 'fail');
        if (failed.length > 0) {
          toast.error(t('servers.toast.testFailed'), {
            description: failed[0]?.detail ?? failed[0]?.label,
          });
          return;
        }
        toast.success(t('servers.toast.testOk'), {
          description: t('servers.toast.testOkDetail', {
            name: response.version ?? serverParam,
            ms: response.checks.reduce((max, entry) => Math.max(max, entry.durationMs), 0),
          }),
        });
      },
      onError: (error) => apiError.toastError(error, t('servers.toast.testFailed')),
    });
  }, [apiError, server.data, serverParam, t, test]);

  const runCheck = useCallback(() => {
    if (server.data === undefined) return;
    check.mutate(server.data.id, {
      onSuccess: (updated) => {
        toast.success(t('server.health.checked'), {
          description: `${updated.name} · ${String(updated.latencyMs ?? 0)} ms`,
        });
      },
      onError: (error) => apiError.toastError(error),
    });
  }, [apiError, check, server.data, t]);

  const toggleMaintenance = useCallback(() => {
    if (server.data === undefined) return;
    maintenance.mutate(
      { serverId: server.data.id, enabled: !server.data.maintenance },
      {
        onSuccess: (updated) =>
          toast.success(
            updated.maintenance
              ? t('servers.toast.maintenanceOn')
              : t('servers.toast.maintenanceOff'),
            { description: updated.name },
          ),
        onError: (error) => apiError.toastError(error),
      },
    );
  }, [apiError, maintenance, server.data, t]);

  if (server.isLoading) return <ServerDetailSkeleton />;

  if (server.isError || server.data === undefined) {
    return (
      <EmptyState
        icon={ServerIcon}
        title={t('server.notFoundTitle')}
        description={apiError.message(server.error)}
        action={
          <Button variant="outline" asChild>
            <Link to="/servers">{t('servers.title')}</Link>
          </Button>
        }
      />
    );
  }

  const current = server.data;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <ProviderMark provider={current.provider} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate font-mono text-(length:--h1) font-semibold tracking-[-0.02em]">
                {current.name}
              </h1>
              <ServerStatusBadge status={current.status} />
              {current.maintenance ? (
                <span className="inline-flex items-center gap-1 rounded-sm bg-secondary px-2 py-0.5 text-xs font-medium">
                  <ConstructionIcon className="size-3" aria-hidden="true" />
                  {t('server.maintenanceBadge')}
                </span>
              ) : null}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span>{PROVIDER_LABELS[current.provider]}</span>
              {current.version === null ? null : (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{current.version}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="ltr-isolate max-w-80 truncate font-mono">{current.endpoint}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{current.region}</span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={runTest} disabled={test.isPending}>
            {test.isPending ? <Spinner /> : <PlugZapIcon />}
            {t('server.testConnection')}
          </Button>
          <Button variant="outline" onClick={() => setSearch({ tab: 'connection' })}>
            <PencilIcon />
            {t('servers.card.editConnection')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label={t('server.moreActions')}>
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-60">
              <DropdownMenuLabel className="font-mono">{current.name}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={runCheck} disabled={check.isPending}>
                <RefreshCwIcon />
                {t('server.health.runNow')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={toggleMaintenance} disabled={maintenance.isPending}>
                <ConstructionIcon />
                {current.maintenance
                  ? t('servers.card.maintenanceOff')
                  : t('servers.card.maintenanceOn')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  dialogs.openHere('rotate-server-credentials', { server: current.name })
                }
              >
                <KeyRoundIcon />
                {t('servers.card.rotate')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setSearch({ tab: 'connection' })}>
                <Trash2Icon />
                {t('servers.card.remove')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(next) => setSearch({ tab: next })}>
        <TabsList variant="line" className="mb-(--gap) w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">{t('server.tab.overview')}</TabsTrigger>
          <TabsTrigger value="buckets">
            {t('server.tab.buckets')}
            <span className="num ms-1.5 rounded-full bg-muted px-1.5 text-[0.6875rem]">
              {current.counts.buckets}
            </span>
          </TabsTrigger>
          <TabsTrigger value="users">
            {t('server.tab.users')}
            {current.counts.users === null ? null : (
              <span className="num ms-1.5 rounded-full bg-muted px-1.5 text-[0.6875rem]">
                {current.counts.users}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="connection">{t('server.tab.connection')}</TabsTrigger>
          <TabsTrigger value="capabilities">{t('server.tab.capabilities')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-(--gap)">
          <ServerStatusAlert
            serverName={current.name}
            status={current.status}
            detail={current.statusDetail}
            since={current.lastSeenAt}
            actions={
              current.status === 'offline' ? (
                <Button variant="outline" size="sm" onClick={runCheck} disabled={check.isPending}>
                  {check.isPending ? <Spinner /> : <RefreshCwIcon />}
                  {t('servers.card.retryNow')}
                </Button>
              ) : undefined
            }
          />

          <OverviewKpis server={current} capacityTrend={capacityTrendOf(metrics.data)} />

          <div className="grid gap-(--gap) xl:grid-cols-3">
            {/* `min-w-0`: a grid track is min-content-sized by default, so the
                nodes table's six columns widened this one past the viewport and
                the whole page scrolled sideways at 375px instead of the table
                scrolling inside its own container. */}
            <div className="min-w-0 xl:col-span-2">
              <ServerNodesCard serverId={current.id} capability={current.capabilities.nodes} />
            </div>
            <ServerHealthCard
              server={current}
              latency={(metrics.data?.latency ?? []).map((point) => point.ms)}
              latencyLoading={metrics.isLoading}
              onCheckNow={runCheck}
              checking={check.isPending}
            />
          </div>

          <ServerMetricsCard
            metrics={metrics.data}
            loading={metrics.isLoading}
            error={metrics.isError ? metrics.error : null}
            range={range}
            onRangeChange={(next) => setSearch({ range: next })}
          />
        </TabsContent>

        <TabsContent value="buckets">
          <ServerBucketsTab server={current} />
        </TabsContent>

        <TabsContent value="users">
          <ServerUsersTab server={current} />
        </TabsContent>

        <TabsContent value="connection">
          <ServerConnectionTab server={current} />
        </TabsContent>

        <TabsContent value="capabilities">
          <ServerCapabilitiesTab
            server={current}
            onRedetect={runTest}
            redetecting={test.isPending}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}

function capacityTrendOf(
  metrics: { readonly capacity: readonly { readonly usedBytes: number }[] } | undefined,
): readonly number[] {
  return (metrics?.capacity ?? []).map((point) => point.usedBytes);
}

function OverviewKpis({
  server,
  capacityTrend,
}: {
  readonly server: Server;
  readonly capacityTrend: readonly number[];
}) {
  const { t } = useTranslation('pages');
  const format = useFormat();

  const { usedBytes, totalBytes, budget } = server.capacity;
  const ratio =
    usedBytes === null || totalBytes === null || totalBytes === 0 ? null : usedBytes / totalBytes;

  return (
    <div className="grid gap-(--gap) sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        label={budget ? t('server.kpi.budgetUsed') : t('server.kpi.capacityUsed')}
        icon={HardDriveIcon}
        value={<Bytes value={usedBytes} />}
        suffix={totalBytes === null ? undefined : <>/ <Bytes value={totalBytes} /></>}
        footer={
          ratio === null ? (
            <span>{t('server.kpi.capacityUnknown')}</span>
          ) : (
            <>
              <Pct value={ratio} />
              <span>{t('server.kpi.ofUsable')}</span>
            </>
          )
        }
      >
        <Meter
          value={ratio}
          tone={meterToneFor(ratio)}
          label={t('server.kpi.capacityUsed')}
        />
      </KpiCard>

      <KpiCard
        label={t('server.kpi.objects')}
        icon={FilesIcon}
        value={<Num value={server.counts.objects} compact />}
        footer={
          server.counts.objects === null ? (
            <span>{t('server.kpi.objectsUnknown')}</span>
          ) : (
            <span>{t('server.kpi.acrossBuckets', { count: server.counts.buckets })}</span>
          )
        }
      >
        {capacityTrend.length < 2 ? null : (
          <Sparkline
            values={capacityTrend}
            tone="chart-2"
            ariaLabel={t('server.kpi.capacityTrendLabel', {
              from: format.bytes(capacityTrend[0] ?? 0),
              to: format.bytes(capacityTrend.at(-1) ?? 0),
            })}
          />
        )}
      </KpiCard>

      <KpiCard
        label={t('server.kpi.buckets')}
        icon={DatabaseIcon}
        value={<Num value={server.counts.buckets} />}
        footer={<span>{t('server.kpi.bucketsFooter')}</span>}
      >
        <MeterStack
          segments={[
            {
              value: ratio === null ? 1 : Math.min(1, ratio),
              className: 'bg-primary',
              label: t('server.kpi.used'),
            },
            {
              value: ratio === null ? 0 : Math.max(0, 1 - ratio),
              className: 'bg-muted',
              label: t('server.kpi.free'),
            },
          ]}
        />
      </KpiCard>

      <KpiCard
        label={t('server.kpi.users')}
        icon={UsersIcon}
        value={server.counts.users === null ? <Dash /> : <Num value={server.counts.users} />}
        footer={
          <span className="flex items-center gap-1">
            <KeyRoundIcon className="size-3.5" aria-hidden="true" />
            {server.capabilities.accessKeys === 'supported'
              ? t('server.kpi.keysSupported')
              : t('server.kpi.keysUnsupported')}
          </span>
        }
      />
    </div>
  );
}

function ServerDetailSkeleton() {
  return (
    <div className="flex flex-col gap-(--gap)">
      <div className="flex items-start gap-3">
        <Skeleton className="size-10 rounded-md" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-80" />
        </div>
      </div>
      <Skeleton className="h-9 w-96" />
      <div className="grid gap-(--gap) sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_unused, index) => (
          <Skeleton key={index} className="h-32 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
