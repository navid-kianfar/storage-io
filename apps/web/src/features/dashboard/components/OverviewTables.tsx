import { PROVIDER_LABELS, type Bucket, type Server } from '@storage-io/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ArrowRightIcon,
  DatabaseIcon,
  GlobeIcon,
  LockIcon,
  PlusIcon,
  ServerIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Bytes,
  Button,
  DataTable,
  Dash,
  EmptyState,
  Meter,
  Ms,
  Num,
  Pct,
  ProviderMark,
  RelativeTime,
  SectionCard,
  ServerStatusBadge,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  meterToneFor,
} from '@/components/app';

/**
 * The dashboard's two tables. Both are read-only summaries that link onward —
 * the servers page and the buckets page own the actions, and a dashboard that
 * duplicated them would be a second place to keep them correct.
 */

export function ServersOverviewTable({
  servers,
  loading,
  healthIntervalSec,
}: {
  readonly servers: readonly Server[];
  readonly loading: boolean;
  readonly healthIntervalSec: number;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();

  const columns = useMemo<readonly ColumnDef<Server, unknown>[]>(
    () => [
      {
        id: 'server',
        header: () => t('overview.servers.server'),
        cell: ({ row }) => {
          const server = row.original;
          return (
            <div className="flex items-center gap-2.5">
              <ProviderMark provider={server.provider} size="sm" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-[0.8125rem] font-medium">
                  {server.name}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {PROVIDER_LABELS[server.provider]} · {server.region}
                </span>
              </span>
            </div>
          );
        },
      },
      {
        id: 'status',
        header: () => t('overview.servers.status'),
        cell: ({ row }) => <ServerStatusBadge status={row.original.status} />,
      },
      {
        id: 'capacity',
        size: 220,
        header: () => t('overview.servers.capacity'),
        cell: ({ row }) => {
          const { usedBytes, totalBytes } = row.original.capacity;
          const ratio =
            usedBytes === null || totalBytes === null || totalBytes === 0
              ? null
              : usedBytes / totalBytes;
          return (
            <div className="flex flex-col gap-1">
              <Meter
                value={ratio}
                tone={meterToneFor(ratio)}
                label={t('overview.servers.capacityMeter', { name: row.original.name })}
              />
              <span className="num text-xs text-muted-foreground">
                <Bytes value={usedBytes} />
                {totalBytes === null ? null : (
                  <>
                    {' / '}
                    <Bytes value={totalBytes} />
                  </>
                )}
              </span>
            </div>
          );
        },
      },
      {
        id: 'buckets',
        header: () => t('overview.servers.buckets'),
        cell: ({ row }) => <Num value={row.original.counts.buckets} />,
      },
      {
        id: 'latency',
        header: () => t('overview.servers.latency'),
        cell: ({ row }) => (
          <Ms
            value={row.original.latencyMs}
            className={row.original.status === 'degraded' ? 'text-warning' : undefined}
          />
        ),
      },
    ],
    [t],
  );

  return (
    <SectionCard
      title={t('overview.servers.title')}
      description={t('overview.servers.description', { seconds: healthIntervalSec })}
      action={
        <Button variant="ghost" size="sm" asChild>
          <Link to="/servers">
            {tCommon('action.manage')}
            <ArrowRightIcon className="flip-rtl" />
          </Link>
        </Button>
      }
      flush
    >
      <DataTable
        aria-label={t('overview.servers.title')}
        columns={columns}
        data={servers}
        getRowId={(server) => server.id}
        loading={loading}
        onRowClick={(server) =>
          void navigate({ to: '/servers/$serverId', params: { serverId: server.id } })
        }
        emptyState={
          <EmptyState
            icon={ServerIcon}
            title={t('servers.empty.title')}
            description={t('servers.empty.description')}
            action={
              <Button onClick={() => void navigate({ to: '/servers/new' })}>
                <PlusIcon />
                {t('servers.add')}
              </Button>
            }
          />
        }
      />
    </SectionCard>
  );
}

export function LargestBucketsTable({
  buckets,
  loading,
}: {
  readonly buckets: readonly Bucket[];
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomain } = useTranslation('domain');
  const navigate = useNavigate();

  const columns = useMemo<readonly ColumnDef<Bucket, unknown>[]>(
    () => [
      {
        id: 'bucket',
        header: () => t('overview.buckets.bucket'),
        cell: ({ row }) => {
          const bucket = row.original;
          return (
            <div className="flex items-center gap-2">
              <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate font-mono text-[0.8125rem] font-medium">{bucket.name}</span>
              {bucket.objectLock ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>{tDomain('capability.objectLock')}</TooltipContent>
                </Tooltip>
              ) : null}
              {bucket.access === 'public-read' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <GlobeIcon className="size-3.5 shrink-0 text-warning" />
                  </TooltipTrigger>
                  <TooltipContent>{tDomain('access.public-read')}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'server',
        header: () => t('overview.buckets.server'),
        cell: ({ row }) => (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {row.original.serverName}
          </span>
        ),
      },
      {
        id: 'objects',
        header: () => t('overview.buckets.objects'),
        cell: ({ row }) => <Num value={row.original.objects} compact />,
      },
      {
        id: 'size',
        header: () => t('overview.buckets.size'),
        cell: ({ row }) => <Bytes value={row.original.sizeBytes} />,
      },
      {
        id: 'quota',
        size: 180,
        header: () => t('overview.buckets.quota'),
        cell: ({ row }) => {
          const bucket = row.original;
          if (bucket.quota === null) {
            return (
              <span className="text-xs text-muted-foreground">{tCommon('meter.noQuota')}</span>
            );
          }
          const ratio =
            bucket.sizeBytes === null || bucket.quota.limitBytes === 0
              ? null
              : bucket.sizeBytes / bucket.quota.limitBytes;
          return (
            <div className="flex items-center gap-2">
              <Meter
                value={ratio}
                tone={meterToneFor(ratio)}
                className="flex-1"
                label={t('overview.buckets.quotaMeter', { name: bucket.name })}
              />
              <Pct value={ratio} className="text-xs text-muted-foreground" />
            </div>
          );
        },
      },
      {
        id: 'versioning',
        header: () => t('overview.buckets.versioning'),
        cell: ({ row }) => {
          const state = row.original.versioning;
          return (
            <Badge
              variant={
                state === 'enabled' ? 'success' : state === 'suspended' ? 'secondary' : 'outline'
              }
            >
              {tDomain(`versioning.${state}`)}
            </Badge>
          );
        },
      },
      {
        id: 'statsAt',
        header: () => t('overview.buckets.lastStats'),
        cell: ({ row }) =>
          row.original.statsAt === null ? (
            <Dash />
          ) : (
            <RelativeTime value={row.original.statsAt} className="text-muted-foreground" />
          ),
      },
    ],
    [t, tCommon, tDomain],
  );

  return (
    <SectionCard
      title={t('overview.buckets.title')}
      description={t('overview.buckets.description')}
      action={
        <Button variant="ghost" size="sm" asChild>
          <Link to="/buckets">
            {t('overview.buckets.allBuckets')}
            <ArrowRightIcon className="flip-rtl" />
          </Link>
        </Button>
      }
      flush
    >
      <DataTable
        aria-label={t('overview.buckets.title')}
        columns={columns}
        data={buckets}
        getRowId={(bucket) => `${bucket.serverId}/${bucket.name}`}
        loading={loading}
        onRowClick={(bucket) =>
          void navigate({ to: '/buckets/$bucketId', params: { bucketId: bucket.id } })
        }
        emptyState={<EmptyState icon={DatabaseIcon} title={t('overview.buckets.emptyTitle')} />}
      />
    </SectionCard>
  );
}
