import type { Dashboard } from '@storage-io/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  DatabaseIcon,
  FilesIcon,
  HardDriveIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  UploadIcon,
} from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Bytes,
  Delta,
  EmptyState,
  KpiCard,
  Meter,
  MeterStack,
  Num,
  PageHeader,
  SectionCard,
  Skeleton,
  Sparkline,
  Spinner,
  StatusDot,
  meterToneFor,
} from '@/components/app';
import {
  ActiveJobsCard,
  ExpiringKeysCard,
  QuickActionsCard,
  RecentActivityCard,
  StorageByServerCard,
} from '@/features/dashboard/components/OverviewCards';
import {
  LargestBucketsTable,
  ServersOverviewTable,
} from '@/features/dashboard/components/OverviewTables';
import { useCheckServer, useServers } from '@/features/servers/api';
import { useDashboard, useSettings } from '@/features/shell/api';
import { useApiError } from '@/lib/api/useApiError';
import { useFormat } from '@/lib/format/FormatProvider';

const GrowthChart = lazy(() => import('@/features/dashboard/components/GrowthChart'));

/**
 * The overview. Everything on it is live: `GET /dashboard` for the numbers and
 * `GET /servers` for the table, both invalidated by the shell's SSE stream, so a
 * health change or a finished job updates this page without a poll.
 *
 * With no servers connected there is nothing to summarise, so this redirects to
 * the first-run wizard — that is the only condition under which this page does not
 * render itself.
 */
export function OverviewPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const apiError = useApiError();

  // Read once: the greeting must not change between two renders of this page.
  const [greeting] = useState(greetingKeyFor);

  const dashboard = useDashboard();
  const servers = useServers();
  const settings = useSettings();
  const check = useCheckServer();

  const noServers = servers.isSuccess && servers.data.items.length === 0;

  useEffect(() => {
    if (!noServers) return;
    void navigate({ to: '/welcome', replace: true });
  }, [navigate, noServers]);

  const data = dashboard.data;
  // An offline server outranks a degraded one: the banner carries a single
  // incident, and it should be the one costing the operator the most right now.
  const incident = [...(data?.incidents ?? [])].sort(
    (left, right) => incidentRank(right.status) - incidentRank(left.status),
  )[0];

  const retryIncident = useCallback(() => {
    if (incident === undefined) return;
    check.mutate(incident.serverId, {
      onSuccess: (updated) => {
        if (updated.status === 'healthy') {
          toast.success(t('servers.toast.backOnline'), { description: updated.name });
          return;
        }
        toast.error(t('servers.toast.stillDown'), {
          description: updated.statusDetail ?? updated.name,
        });
      },
      onError: (error) => apiError.toastError(error, t('servers.toast.stillDown')),
    });
  }, [apiError, check, incident, t]);

  if (dashboard.isError) {
    return (
      <EmptyState
        icon={ServerIcon}
        title={tCommon('state.error')}
        description={apiError.message(dashboard.error)}
        action={
          <Button variant="outline" onClick={() => void dashboard.refetch()}>
            <RefreshCwIcon />
            {tCommon('action.retry')}
          </Button>
        }
      />
    );
  }

  return (
    <>
      <PageHeader
        title={t(`overview.greeting.${greeting}`, {
          name: settings.data?.profile.displayName ?? '',
        })}
        description={t('overview.description')}
        actions={
          <>
            <Button variant="outline" onClick={() => void navigate({ to: '/servers/new' })}>
              <PlusIcon />
              {t('servers.add')}
            </Button>
            <Button onClick={() => void navigate({ to: '/browse' })}>
              <UploadIcon />
              {tCommon('action.upload')}
            </Button>
          </>
        }
      />

      {incident === undefined ? null : (
        <IncidentBanner
          incident={incident}
          onRetry={retryIncident}
          retrying={check.isPending}
        />
      )}

      <div className="grid gap-(--gap) sm:grid-cols-2 xl:grid-cols-4">
        <StorageKpi dashboard={data} loading={dashboard.isLoading} />
        <ObjectsKpi dashboard={data} loading={dashboard.isLoading} />
        <BucketsKpi dashboard={data} loading={dashboard.isLoading} />
        <ServersKpi dashboard={data} loading={dashboard.isLoading} />
      </div>

      <div className="mt-(--gap) grid gap-(--gap) xl:grid-cols-3">
        <SectionCard
          className="xl:col-span-2"
          title={t('overview.growth.title')}
          description={t('overview.growth.description')}
          action={
            <span className="flex items-center gap-3 text-xs text-muted-foreground">
              <LegendSwatch color="var(--chart-1)" label={t('overview.growth.used')} />
              <LegendSwatch
                color="var(--muted-foreground)"
                label={t('overview.growth.projected')}
                dashed
              />
            </span>
          }
        >
          {dashboard.isLoading ? (
            <Skeleton className="h-52 w-full" />
          ) : (data?.growth ?? []).length < 2 ? (
            <EmptyState
              icon={HardDriveIcon}
              title={t('overview.growth.emptyTitle')}
              description={t('overview.growth.emptyDescription')}
              className="py-10"
            />
          ) : (
            <Suspense fallback={<Skeleton className="h-52 w-full" />}>
              <GrowthChart growth={data?.growth ?? []} />
            </Suspense>
          )}
        </SectionCard>

        <ActiveJobsCard jobs={data?.jobs ?? []} loading={dashboard.isLoading} />
      </div>

      <div className="mt-(--gap) grid gap-(--gap) xl:grid-cols-3">
        <StorageByServerCard byServer={data?.byServer ?? []} loading={dashboard.isLoading} />
        <QuickActionsCard />
        <ExpiringKeysCard keys={data?.expiringKeys ?? []} loading={dashboard.isLoading} />
      </div>

      <div className="mt-(--gap) grid gap-(--gap) xl:grid-cols-3">
        {/* `min-w-0`: a grid track is min-content-sized by default, so the servers
            table's five columns widened this one past the viewport and the page
            scrolled sideways at 375px instead of the table scrolling inside it. */}
        <div className="min-w-0 xl:col-span-2">
          <ServersOverviewTable
            servers={servers.data?.items ?? []}
            loading={servers.isLoading}
            healthIntervalSec={settings.data?.health.defaultIntervalSec ?? 30}
          />
        </div>
        <RecentActivityCard events={data?.activity ?? []} loading={dashboard.isLoading} />
      </div>

      <div className="mt-(--gap)">
        <LargestBucketsTable
          buckets={data?.largestBuckets ?? []}
          loading={dashboard.isLoading}
        />
      </div>
    </>
  );
}

function incidentRank(status: Dashboard['incidents'][number]['status']): number {
  return status === 'offline' ? 2 : status === 'degraded' ? 1 : 0;
}

/** Local hour, because the greeting is about the operator's day, not the server's. */
function greetingKeyFor(): 'morning' | 'afternoon' | 'evening' {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

function LegendSwatch({
  color,
  label,
  dashed = false,
}: {
  readonly color: string;
  readonly label: string;
  readonly dashed?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="h-0.5 w-4 rounded-full"
        style={
          dashed
            ? { backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` }
            : { background: color }
        }
      />
      {label}
    </span>
  );
}

function IncidentBanner({
  incident,
  onRetry,
  retrying,
}: {
  readonly incident: Dashboard['incidents'][number];
  readonly onRetry: () => void;
  readonly retrying: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();

  return (
    <div className="mb-(--gap-lg)">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/6 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            <span className="font-mono">{incident.serverName}</span>{' '}
            <span className="font-normal">
              {t(
                incident.status === 'offline'
                  ? 'servers.incident.offline'
                  : 'servers.incident.degraded',
              )}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {incident.detail ?? t('overview.incident.noDetail')}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          {retrying ? <Spinner /> : <RefreshCwIcon />}
          {tCommon('action.retry')}
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/servers/$serverId" params={{ serverId: incident.serverId }}>
            {tCommon('action.details')}
            <ArrowRightIcon className="flip-rtl" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------- KPIs --------------------------------- */

function StorageKpi({
  dashboard,
  loading,
}: {
  readonly dashboard: Dashboard | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  if (loading || dashboard === undefined) return <KpiSkeleton />;

  const { bucketsBytes, capacityBytes, bucketsDelta7dBytes } = dashboard.totals;
  const ratio = capacityBytes === null || capacityBytes === 0 ? null : bucketsBytes / capacityBytes;

  return (
    <KpiCard
      label={t('overview.kpi.storageUsed')}
      icon={HardDriveIcon}
      value={<Bytes value={bucketsBytes} />}
      suffix={capacityBytes === null ? undefined : <>/ <Bytes value={capacityBytes} /></>}
      footer={
        <>
          <Delta direction={bucketsDelta7dBytes >= 0 ? 'up' : 'down'}>
            <Bytes value={Math.abs(bucketsDelta7dBytes)} />
          </Delta>
          <span>{t('overview.kpi.thisWeek')}</span>
        </>
      }
    >
      <Meter value={ratio} tone={meterToneFor(ratio)} label={t('overview.kpi.storageUsed')} />
    </KpiCard>
  );
}

function ObjectsKpi({
  dashboard,
  loading,
}: {
  readonly dashboard: Dashboard | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  const format = useFormat();
  if (loading || dashboard === undefined) return <KpiSkeleton />;

  const trend = dashboard.growth.map((point) => point.bucketsBytes);
  const delta = dashboard.totals.objectsDeltaToday;

  return (
    <KpiCard
      label={t('overview.kpi.objects')}
      icon={FilesIcon}
      value={<Num value={dashboard.totals.objects} compact />}
      footer={
        delta === null ? (
          <span>{t('overview.kpi.noDeltaToday')}</span>
        ) : (
          <>
            <Delta direction={delta >= 0 ? 'up' : 'down'}>
              <Num value={Math.abs(delta)} compact />
            </Delta>
            <span>{t('overview.kpi.today')}</span>
          </>
        )
      }
    >
      {trend.length < 2 ? null : (
        <Sparkline
          values={trend}
          tone="chart-2"
          ariaLabel={t('overview.kpi.growthTrendLabel', {
            from: format.bytes(trend[0] ?? 0),
            to: format.bytes(trend.at(-1) ?? 0),
          })}
        />
      )}
    </KpiCard>
  );
}

function BucketsKpi({
  dashboard,
  loading,
}: {
  readonly dashboard: Dashboard | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  if (loading || dashboard === undefined) return <KpiSkeleton />;

  const { buckets, nearQuotaBuckets } = dashboard.totals;
  const nearRatio = buckets === 0 ? 0 : nearQuotaBuckets / buckets;

  return (
    <KpiCard
      label={t('overview.kpi.buckets')}
      icon={DatabaseIcon}
      value={<Num value={buckets} />}
      footer={
        nearQuotaBuckets === 0 ? (
          <span>{t('overview.kpi.noneNearQuota')}</span>
        ) : (
          <Badge variant="warning" asChild>
            <Link to="/quotas" search={{ filter: 'near' }}>
              <Num value={nearQuotaBuckets} /> {t('overview.kpi.nearQuota')}
            </Link>
          </Badge>
        )
      }
    >
      <MeterStack
        segments={[
          {
            value: 1 - nearRatio,
            className: 'bg-success',
            label: t('overview.kpi.withinQuota'),
          },
          { value: nearRatio, className: 'bg-warning', label: t('overview.kpi.nearQuota') },
        ]}
      />
    </KpiCard>
  );
}

function ServersKpi({
  dashboard,
  loading,
}: {
  readonly dashboard: Dashboard | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  if (loading || dashboard === undefined) return <KpiSkeleton />;

  const { total, healthy, degraded, offline } = dashboard.totals.servers;
  const share = (value: number) => (total === 0 ? 0 : value / total);

  return (
    <KpiCard
      label={t('overview.kpi.healthyServers')}
      icon={ServerIcon}
      value={<Num value={healthy} />}
      suffix={<>/ <Num value={total} /></>}
      footer={
        <>
          <span className="flex items-center gap-1">
            <StatusDot tone="warn" />
            <Num value={degraded} /> {t('overview.kpi.degraded')}
          </span>
          <span className="flex items-center gap-1">
            <StatusDot tone="err" />
            <Num value={offline} /> {t('overview.kpi.offline')}
          </span>
        </>
      }
    >
      <MeterStack
        segments={[
          { value: share(healthy), className: 'bg-success', label: t('overview.kpi.healthy') },
          { value: share(degraded), className: 'bg-warning', label: t('overview.kpi.degraded') },
          {
            value: share(offline),
            className: 'bg-destructive',
            label: t('overview.kpi.offline'),
          },
        ]}
      />
    </KpiCard>
  );
}

function KpiSkeleton() {
  return <Skeleton className="h-32 rounded-xl" />;
}
