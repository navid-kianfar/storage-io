import type { CapabilityState, ServerDrive, ServerNode } from '@storage-io/contracts';
import type { ColumnDef } from '@tanstack/react-table';
import {
  CpuIcon,
  HardDriveIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Bytes,
  Button,
  DataTable,
  Dash,
  Duration,
  EmptyState,
  Meter,
  Pct,
  SectionCard,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
  meterToneFor,
} from '@/components/app';
import { useServerDrives, useServerNodes } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';

/**
 * Nodes and drives, for the providers whose admin API reports them (MinIO's
 * `nodes` capability today). A provider without it gets the unsupported state
 * rather than an empty table — "no nodes" and "this driver cannot see nodes" are
 * different facts and the operator needs to know which one they are looking at.
 *
 * Clicking a node opens the drive sheet, which is the only place the per-drive
 * paths, models and healing state exist.
 */
export function ServerNodesCard({
  serverId,
  capability,
}: {
  readonly serverId: string;
  readonly capability: CapabilityState;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const supported = capability === 'supported';
  const nodes = useServerNodes(serverId, supported);
  const [openNode, setOpenNode] = useState<string | null>(null);

  const items = nodes.data?.items ?? [];
  const drivesOnline = items.reduce((sum, node) => sum + node.drivesOnline, 0);
  const drivesTotal = items.reduce((sum, node) => sum + node.drivesTotal, 0);

  const columns = useMemo<readonly ColumnDef<ServerNode, unknown>[]>(
    () => [
      {
        id: 'node',
        header: () => t('server.nodes.node'),
        cell: ({ row }) => {
          const node = row.original;
          return (
            <div className="flex items-center gap-2.5">
              <span
                className={
                  node.state === 'online'
                    ? 'grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground'
                    : 'grid size-7 shrink-0 place-items-center rounded-md bg-warning/15 text-warning'
                }
              >
                <CpuIcon className="size-3.5" aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-[0.8125rem] font-medium">{node.name}</span>
                <span className="ltr-isolate truncate font-mono text-xs text-muted-foreground">
                  {node.endpoint}
                </span>
              </span>
            </div>
          );
        },
      },
      {
        id: 'drives',
        header: () => t('server.nodes.drives'),
        cell: ({ row }) => {
          const node = row.original;
          const complete = node.drivesOnline === node.drivesTotal;
          return (
            <Badge variant={complete ? 'success' : 'warning'}>
              {complete ? <HardDriveIcon /> : <TriangleAlertIcon />}
              <span className="num">
                {node.drivesOnline} / {node.drivesTotal}
              </span>
            </Badge>
          );
        },
      },
      {
        id: 'uptime',
        header: () => t('server.nodes.uptime'),
        cell: ({ row }) => (
          <Duration seconds={row.original.uptimeSec} className="text-muted-foreground" />
        ),
      },
      {
        id: 'cpu',
        size: 140,
        header: () => t('server.nodes.cpu'),
        cell: ({ row }) => <UsageCell ratio={row.original.cpu} />,
      },
      {
        id: 'mem',
        size: 140,
        header: () => t('server.nodes.memory'),
        cell: ({ row }) => <UsageCell ratio={row.original.mem} />,
      },
      {
        id: 'storage',
        header: () => t('server.nodes.storage'),
        cell: ({ row }) => {
          const node = row.original;
          return (
            <span className="num text-xs text-muted-foreground">
              <Bytes value={node.usedBytes} />
              {node.totalBytes === null ? null : (
                <>
                  {' / '}
                  <Bytes value={node.totalBytes} />
                </>
              )}
            </span>
          );
        },
      },
    ],
    [t],
  );

  if (!supported) {
    return (
      <SectionCard title={t('server.nodes.title')} description={t('server.nodes.description')}>
        <EmptyState
          icon={HardDriveIcon}
          title={tCommon('state.notSupported')}
          description={t('server.nodes.unsupported')}
        />
      </SectionCard>
    );
  }

  return (
    <>
      <SectionCard
        title={t('server.nodes.title')}
        description={
          nodes.isLoading ? (
            <Skeleton className="h-3 w-40" />
          ) : (
            <>
              {t('server.nodes.summary', { nodes: items.length })} ·{' '}
              <span className="num">
                {drivesOnline} / {drivesTotal}
              </span>{' '}
              {t('server.nodes.drivesOnline')}
            </>
          )
        }
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void nodes.refetch()}
            disabled={nodes.isFetching}
          >
            <RefreshCwIcon />
            {tCommon('action.refresh')}
          </Button>
        }
        flush
      >
        {nodes.isError ? (
          <EmptyState
            icon={HardDriveIcon}
            title={tCommon('state.error')}
            description={apiError.message(nodes.error)}
          />
        ) : (
          <DataTable
            aria-label={t('server.nodes.title')}
            columns={columns}
            data={items}
            getRowId={(node) => node.name}
            loading={nodes.isLoading}
            onRowClick={(node) => setOpenNode(node.name)}
            emptyState={
              <EmptyState icon={HardDriveIcon} title={t('server.nodes.emptyTitle')} />
            }
          />
        )}
      </SectionCard>

      <DriveDetailsSheet
        serverId={serverId}
        node={openNode}
        onClose={() => setOpenNode(null)}
      />
    </>
  );
}

function UsageCell({ ratio }: { readonly ratio: number | null }) {
  if (ratio === null) return <Dash />;
  return (
    <div className="flex flex-col gap-1">
      <Meter value={ratio} tone={meterToneFor(ratio)} />
      <Pct value={ratio} className="text-xs text-muted-foreground" />
    </div>
  );
}

const DRIVE_STATE_VARIANTS = {
  ok: 'success',
  offline: 'danger',
  healing: 'warning',
  unformatted: 'secondary',
  unknown: 'outline',
} as const;

export function DriveDetailsSheet({
  serverId,
  node,
  onClose,
}: {
  readonly serverId: string;
  readonly node: string | null;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const drives = useServerDrives(serverId, node);

  return (
    <Sheet
      open={node !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="font-mono">{node ?? ''}</SheetTitle>
          <SheetDescription>{t('server.drives.description')}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-2 overflow-y-auto px-4 pb-6">
          {drives.isLoading ? (
            Array.from({ length: 4 }, (_unused, index) => (
              <Skeleton key={index} className="h-16 rounded-lg" />
            ))
          ) : drives.isError ? (
            <p className="text-sm text-destructive">{apiError.message(drives.error)}</p>
          ) : (drives.data?.items ?? []).length === 0 ? (
            <EmptyState icon={HardDriveIcon} title={tCommon('state.empty')} />
          ) : (
            (drives.data?.items ?? []).map((drive) => <DriveRow key={drive.path} drive={drive} />)
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DriveRow({ drive }: { readonly drive: ServerDrive }) {
  const { t } = useTranslation('pages');
  const ratio =
    drive.usedBytes === null || drive.totalBytes === null || drive.totalBytes === 0
      ? null
      : drive.usedBytes / drive.totalBytes;

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="ltr-isolate truncate font-mono text-[0.8125rem] font-medium">
            {drive.path}
          </span>
          {drive.model === null ? null : (
            <span className="truncate text-xs text-muted-foreground">{drive.model}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {drive.healing ? <Badge variant="warning">{t('server.drives.healing')}</Badge> : null}
          <Badge variant={DRIVE_STATE_VARIANTS[drive.state]}>
            {t(`server.drives.state.${drive.state}`)}
          </Badge>
        </div>
      </div>
      <Meter
        value={ratio}
        tone={meterToneFor(ratio)}
        label={t('server.drives.usage', { path: drive.path })}
      />
      <span className="num text-xs text-muted-foreground">
        <Bytes value={drive.usedBytes} />
        {drive.totalBytes === null ? null : (
          <>
            {' / '}
            <Bytes value={drive.totalBytes} />
          </>
        )}
        {ratio === null ? null : (
          <>
            {' · '}
            <Pct value={ratio} />
          </>
        )}
      </span>
    </div>
  );
}
