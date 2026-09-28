import { SETTINGS_DEFAULTS, type Settings } from '@storage-io/contracts';
import type { TFunction } from 'i18next';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  EllipsisIcon,
  FolderOpenIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/app/Alert';
import { Badge } from '@/components/app/Badge';
import { Button } from '@/components/app/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/app/Card';
import { Combobox } from '@/components/app/Combobox';
import { DataTable } from '@/components/app/DataTable';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/app/DropdownMenu';
import { EmptyState } from '@/components/app/EmptyState';
import { Bytes, BytesPerSecond, Duration, Num, Pct } from '@/components/app/Format';
import { FormActions, OptionRow } from '@/components/app/FormRow';
import { FormField } from '@/components/app/FormField';
import { Meter, MeterStack } from '@/components/app/Meter';
import { PageHeader } from '@/components/app/PageHeader';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Skeleton } from '@/components/app/Skeleton';
import { Slider } from '@/components/app/Slider';
import { Spinner } from '@/components/app/Spinner';
import { Switch } from '@/components/app/Switch';
import { useSettings } from '@/features/shell/api';
import { toastProblem } from '@/lib/api/problems';
import {
  currentSpeed,
  sortedTransfers,
  transferCounts,
  transferRatio,
  useTransfers,
  type Transfer,
} from '@/stores/transfers';
import {
  cancelTransfer,
  clearCompletedTransfers,
  pauseAllTransfers,
  pauseTransfer,
  removeTransfer,
  resumeAllTransfers,
  resumeTransfer,
  retryTransfer,
} from './engine';
import { useUpdateTransferSettings } from './api';

/** Recharts is ~90 kB; the chart loads when the page does, not with the app. */
const ThroughputChart = lazy(async () => {
  const module = await import('./ThroughputChart');
  return { default: module.ThroughputChart };
});

/**
 * `/transfers` — everything this browser tab is uploading or downloading.
 *
 * The queue is not server state: it lives in `src/stores/transfers.ts` and is driven
 * by `engine.ts`, so this page is a view over a store rather than a query. Closing
 * the tab ends the transfers, which is exactly what the note at the bottom says and
 * why bulk jobs exist.
 *
 * The settings card is the exception: those values *are* server state
 * (`Settings.transfers`), shared with the API's own streaming endpoints, so they are
 * saved with `PATCH /settings` and pushed into the engine on every change.
 */

const TAB_VALUES = ['all', 'uploads', 'downloads', 'failed'] as const;
type TabValue = (typeof TAB_VALUES)[number];

const BANDWIDTH_CHOICES = [10, 50, 100, 250] as const;
const PART_SIZES = [8, 16, 64] as const;
const PARALLEL_MIN = 1;
const PARALLEL_MAX = 16;
const KEEP_DAYS_CHOICES = [1, 3, 7, 14, 30] as const;
/** `Settings.transfers.retries` is bounded 0..10 by the contract; 0 means "try once". */
const RETRIES_MIN = 0;
const RETRIES_MAX = 10;

export function TransfersPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const search: { readonly tab?: string } = useSearch({ strict: false });

  const transfers = useTransfers((state) => state.transfers);
  const throughput = useTransfers((state) => state.throughput);
  const totals = useTransfers((state) => state.totals);

  const settings = useSettings();
  const saveSettings = useUpdateTransferSettings();

  const tab: TabValue = (TAB_VALUES as readonly string[]).includes(search.tab ?? '')
    ? (search.tab as TabValue)
    : 'all';

  const setTab = useCallback(
    (next: TabValue) => {
      void navigate({
        to: '/transfers',
        search: (previous: Record<string, unknown>) => {
          const merged: Record<string, unknown> = { ...previous, tab: next };
          if (next === 'all') delete merged.tab;
          return merged;
        },
        replace: true,
      });
    },
    [navigate],
  );

  // The engine itself is configured from the shell (`useEngineSettings`), so this
  // page only reads the settings it displays.
  const transferSettings = settings.data?.transfers;

  const counts = useMemo(() => transferCounts(transfers), [transfers]);
  const speed = useMemo(() => currentSpeed(transfers), [transfers]);
  const ordered = useMemo(() => sortedTransfers(transfers), [transfers]);

  const rows = useMemo(() => {
    if (tab === 'uploads') return ordered.filter((item) => item.direction === 'upload');
    if (tab === 'downloads') return ordered.filter((item) => item.direction === 'download');
    if (tab === 'failed') return ordered.filter((item) => item.status === 'failed');
    return ordered;
  }, [ordered, tab]);

  const columns = useMemo<readonly ColumnDef<Transfer, unknown>[]>(
    () => transferColumns({ t, tCommon, navigate }),
    [t, tCommon, navigate],
  );

  const sessionBytes = totals.uploadedBytes + totals.downloadedBytes;
  const anyActive = counts.active > 0;

  return (
    <>
      <div className="hero-glow" />
      <PageHeader
        title={t('transfers.heading')}
        description={t('transfers.subheading')}
        actions={
          <>
            <Combobox
              options={[
                { value: 'none', label: t('transfers.bandwidth.none') },
                ...BANDWIDTH_CHOICES.map((mbps) => ({
                  value: String(mbps),
                  label: t('transfers.bandwidth.limit', { mbps }),
                })),
              ]}
              value={
                transferSettings?.bandwidthLimitMbps == null
                  ? 'none'
                  : String(transferSettings.bandwidthLimitMbps)
              }
              onValueChange={(value) => {
                const mbps = value === null || value === 'none' ? null : Number.parseInt(value, 10);
                saveSettings.mutate(
                  { bandwidthLimitMbps: mbps },
                  {
                    onSuccess: () => toast.success(t('transfers.bandwidth.saved')),
                    onError: (error) => toastProblem(error, tCommon),
                  },
                );
              }}
              aria-label={t('transfers.bandwidth.label')}
              className="w-52"
            />
            <Button
              variant="outline"
              onClick={() => {
                clearCompletedTransfers();
                toast.info(t('transfers.action.cleared'));
              }}
            >
              <Trash2Icon />
              {t('transfers.action.clearCompleted')}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (anyActive) {
                  pauseAllTransfers();
                  toast.info(t('transfers.action.pausedAll'));
                  return;
                }
                resumeAllTransfers();
              }}
            >
              {anyActive ? <PauseIcon /> : <PlayIcon />}
              {anyActive ? t('transfers.action.pauseAll') : t('transfers.action.resumeAll')}
            </Button>
          </>
        }
      />

      <Card className="mb-(--gap)">
        <CardContent className="flex flex-wrap items-start gap-x-10 gap-y-4">
          <Metric label={t('transfers.metric.uploadSpeed')} tone="success">
            <BytesPerSecond value={speed.up} />
          </Metric>
          <Metric label={t('transfers.metric.downloadSpeed')}>
            <BytesPerSecond value={speed.down} />
          </Metric>
          <Metric label={t('transfers.metric.active')}>
            <Num value={counts.active} />
          </Metric>
          <Metric label={t('transfers.metric.queued')}>
            <Num value={counts.queued} />
          </Metric>
          <Metric label={t('transfers.metric.completed')}>
            <Num value={totals.completed} />
          </Metric>
          <Metric label={t('transfers.metric.failed')} tone={counts.failed > 0 ? 'danger' : undefined}>
            <Num value={counts.failed} />
          </Metric>

          <div className="min-w-56 grow">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('transfers.metric.sessionTotal')}</span>
              <Bytes value={sessionBytes} />
            </div>
            <MeterStack
              className="mt-2"
              segments={[
                {
                  value: sessionBytes === 0 ? 0 : totals.uploadedBytes / sessionBytes,
                  className: 'bg-success',
                  label: t('transfers.metric.uploaded'),
                },
                {
                  value: sessionBytes === 0 ? 0 : totals.downloadedBytes / sessionBytes,
                  className: 'bg-chart-2',
                  label: t('transfers.metric.downloaded'),
                },
              ]}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-(--gap) xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] xl:items-start">
        <DataTable
          aria-label={t('transfers.heading')}
          columns={columns}
          data={rows}
          getRowId={(transfer) => transfer.id}
          emptyState={
            <EmptyState
              icon={ArrowUpDownIcon}
              title={t('transfers.empty.title')}
              description={
                transfers.length === 0 ? t('transfers.empty.none') : t('transfers.empty.description')
              }
            />
          }
          toolbar={
            <SegmentedControl
              options={[
                { value: 'all', label: t('transfers.tab.all'), count: <Num value={transfers.length} /> },
                {
                  value: 'uploads',
                  label: t('transfers.tab.uploads'),
                  count: (
                    <Num
                      value={transfers.filter((item) => item.direction === 'upload').length}
                    />
                  ),
                },
                {
                  value: 'downloads',
                  label: t('transfers.tab.downloads'),
                  count: (
                    <Num
                      value={transfers.filter((item) => item.direction === 'download').length}
                    />
                  ),
                },
                { value: 'failed', label: t('transfers.tab.failed'), count: <Num value={counts.failed} /> },
              ]}
              value={tab}
              onValueChange={setTab}
              aria-label={t('transfers.tab.all')}
            />
          }
          toolbarActions={
            <Button variant="outline" size="sm" onClick={() => void navigate({ to: '/browse' })}>
              <UploadIcon />
              {t('transfers.uploadAction')}
            </Button>
          }
        />

        <div className="flex min-w-0 flex-col gap-(--gap)">
          <TransferSettingsCard
            settings={settings.data}
            loading={settings.isLoading}
            saving={saveSettings.isPending}
            onSave={(patch, onDone) =>
              saveSettings.mutate(patch, {
                onSuccess: () => {
                  toast.success(t('transfers.settings.saved'));
                  onDone();
                },
                onError: (error) => toastProblem(error, tCommon, t('transfers.settings.failed')),
              })
            }
          />

          <Card>
            <CardHeader>
              <CardTitle>{t('transfers.chart.title')}</CardTitle>
              <CardDescription>{t('transfers.chart.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              {throughput.length === 0 ? (
                <p className="text-[0.8125rem] text-muted-foreground">{t('transfers.chart.empty')}</p>
              ) : (
                <Suspense fallback={<Skeleton className="h-36 w-full" />}>
                  <ThroughputChart samples={throughput} />
                </Suspense>
              )}
            </CardContent>
          </Card>

          <Alert variant="info">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{t('transfers.jobsNote')}</span>
              <Button variant="outline" size="sm" onClick={() => void navigate({ to: '/jobs' })}>
                {t('transfers.jobsLink')}
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      </div>
    </>
  );
}

function Metric({
  label,
  tone,
  children,
}: {
  readonly label: string;
  readonly tone?: 'success' | 'danger';
  readonly children: ReactNode;
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success-foreground'
      : tone === 'danger'
        ? 'text-destructive-foreground'
        : undefined;
  return (
    <div className="flex flex-col">
      <span className={`text-(length:--kpi-fs) leading-tight font-semibold ${toneClass ?? ''}`}>
        {children}
      </span>
      <span className="text-[0.8125rem] text-muted-foreground">{label}</span>
    </div>
  );
}

/* ------------------------------- the table ------------------------------- */

function transferColumns({
  t,
  tCommon,
  navigate,
}: {
  readonly t: TFunction;
  readonly tCommon: TFunction;
  readonly navigate: ReturnType<typeof useNavigate>;
}): readonly ColumnDef<Transfer, unknown>[] {
  const openLocation = (transfer: Transfer) => {
    const lastSlash = transfer.key.lastIndexOf('/');
    const prefix = lastSlash === -1 ? '' : transfer.key.slice(0, lastSlash + 1);
    void navigate({
      to: '/buckets/$bucketId/browse/$',
      params: { bucketId: transfer.bucketId, _splat: prefix },
    });
  };

  return [
    {
      id: 'direction',
      size: 44,
      enableSorting: false,
      header: () => <span className="sr-only">{t('transfers.column.direction')}</span>,
      cell: ({ row }) => <DirectionIcon transfer={row.original} />,
    },
    {
      id: 'file',
      header: t('transfers.column.file'),
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col">
          <span className="ltr-isolate truncate font-mono text-sm font-medium">
            {row.original.name}
          </span>
          {row.original.status === 'failed' && row.original.error !== null ? (
            <span className="truncate text-xs text-destructive-foreground">
              {row.original.error}
            </span>
          ) : (
            <span className="ltr-isolate truncate font-mono text-xs text-muted-foreground">
              {row.original.bucket}/{row.original.key}
            </span>
          )}
        </div>
      ),
    },
    {
      id: 'size',
      header: t('transfers.column.size'),
      size: 96,
      enableSorting: false,
      cell: ({ row }) => <Bytes value={row.original.totalBytes} />,
    },
    {
      id: 'progress',
      header: t('transfers.column.progress'),
      size: 180,
      enableSorting: false,
      cell: ({ row }) => {
        const ratio = transferRatio(row.original);
        return (
          <div className="flex items-center gap-2">
            <Meter
              value={ratio}
              striped={row.original.status === 'running'}
              // A transfer's progress is not a quota: 100% means finished, so the
              // threshold tones that suit a quota bar would read backwards here.
              tone={progressTone(row.original.status)}
              className="min-w-16 grow"
              label={row.original.name}
            />
            <Pct value={ratio} className="text-xs text-muted-foreground" />
          </div>
        );
      },
    },
    {
      id: 'speed',
      header: t('transfers.column.speed'),
      size: 104,
      enableSorting: false,
      cell: ({ row }) =>
        row.original.status === 'running' ? (
          <BytesPerSecond value={row.original.bytesPerSecond} className="text-[0.8125rem]" />
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'status',
      header: t('transfers.column.status'),
      size: 140,
      enableSorting: false,
      cell: ({ row }) => <StatusCell transfer={row.original} t={t} />,
    },
    {
      id: 'actions',
      size: 96,
      enableSorting: false,
      header: () => <span className="sr-only">{tCommon('table.rowActions')}</span>,
      cell: ({ row }) => {
        const transfer = row.original;
        return (
          <div className="flex justify-end gap-0.5">
            {transfer.status === 'running' ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('transfers.row.pause')}
                onClick={() => pauseTransfer(transfer.id)}
              >
                <PauseIcon />
              </Button>
            ) : transfer.status === 'paused' ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('transfers.row.resume')}
                onClick={() => resumeTransfer(transfer.id)}
              >
                <PlayIcon />
              </Button>
            ) : transfer.status === 'failed' ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('transfers.row.retry')}
                onClick={() => retryTransfer(transfer.id)}
              >
                <RotateCwIcon />
              </Button>
            ) : transfer.status === 'queued' ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('transfers.row.cancel')}
                onClick={() => cancelTransfer(transfer.id)}
              >
                <XIcon />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('transfers.row.openLocation')}
                onClick={() => openLocation(transfer)}
              >
                <FolderOpenIcon />
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('transfers.row.more')}>
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => openLocation(transfer)}>
                  <FolderOpenIcon />
                  {t('transfers.row.openLocation')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    const uri = `s3://${transfer.bucket}/${transfer.key}`;
                    void navigator.clipboard.writeText(uri).then(
                      () => toast.success(tCommon('action.copied'), { description: uri }),
                      () => toast.error(tCommon('action.copy'), { description: uri }),
                    );
                  }}
                >
                  <CopyIcon />
                  {t('transfers.row.copyUri')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => retryTransfer(transfer.id)}>
                  <RefreshCwIcon />
                  {t('transfers.row.retry')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => removeTransfer(transfer.id)}>
                  <XIcon />
                  {t('transfers.row.remove')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];
}

/** Green when it finished, red when it failed, neutral while it is moving. */
function progressTone(status: Transfer['status']): 'ok' | 'crit' | 'default' {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'crit';
  return 'default';
}

function DirectionIcon({ transfer }: { readonly transfer: Transfer }) {
  if (transfer.status === 'failed') {
    return <CircleAlertIcon className="size-4 text-destructive" aria-hidden="true" />;
  }
  if (transfer.status === 'completed') {
    return <CircleCheckIcon className="size-4 text-success-foreground" aria-hidden="true" />;
  }
  if (transfer.status === 'queued') {
    return <ClockIcon className="size-4 text-muted-foreground" aria-hidden="true" />;
  }
  return transfer.direction === 'upload' ? (
    <ArrowUpIcon className="size-4 text-success-foreground" aria-hidden="true" />
  ) : (
    <ArrowDownIcon className="size-4 text-info-foreground" aria-hidden="true" />
  );
}

function StatusCell({
  transfer,
  t,
}: {
  readonly transfer: Transfer;
  readonly t: TFunction;
}) {
  if (transfer.status === 'running') {
    if (transfer.etaSeconds === null) {
      return <span className="text-[0.8125rem] text-muted-foreground">—</span>;
    }
    return (
      <span className="flex items-center gap-1 text-[0.8125rem] text-muted-foreground">
        <Duration seconds={transfer.etaSeconds} />
        {t('transfers.status.left')}
      </span>
    );
  }
  const variant =
    transfer.status === 'completed'
      ? 'success'
      : transfer.status === 'failed'
        ? 'danger'
        : transfer.status === 'paused'
          ? 'warning'
          : 'outline';
  return <Badge variant={variant}>{t(`transfers.status.${transfer.status}`)}</Badge>;
}

/* ---------------------------- the settings card -------------------------- */

/**
 * Exported so Settings → Transfers renders the same card rather than a second
 * form against the same `Settings.transfers` section. One card, two places.
 */
export function TransferSettingsCard({
  settings,
  loading,
  saving,
  onSave,
}: {
  readonly settings: Settings | undefined;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly onSave: (patch: Partial<Settings['transfers']>, onDone: () => void) => void;
}) {
  const { t } = useTranslation('pages');
  const saved = settings?.transfers;

  if (loading || saved === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('transfers.settings.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </CardContent>
      </Card>
    );
  }

  // Keyed by the saved values: the draft starts from the server's answer and a
  // successful save remounts the form with it, so nothing has to copy one into the
  // other in an effect.
  return <SettingsForm key={JSON.stringify(saved)} saved={saved} saving={saving} onSave={onSave} />;
}

function SettingsForm({
  saved,
  saving,
  onSave,
}: {
  readonly saved: Settings['transfers'];
  readonly saving: boolean;
  readonly onSave: (patch: Partial<Settings['transfers']>, onDone: () => void) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const [draft, setDraft] = useState<Settings['transfers']>(saved);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  function patch(next: Partial<Settings['transfers']>): void {
    setDraft((current) => ({ ...current, ...next }));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('transfers.settings.title')}</CardTitle>
        <CardDescription>{t('transfers.settings.description')}</CardDescription>
      </CardHeader>

      <CardContent className="grid items-start gap-4 sm:grid-cols-2">
        <FormField
          label={t('transfers.settings.parallel')}
          hint={t('transfers.settings.parallelHint')}
        >
          {({ id, describedBy }) => (
            <div className="flex h-(--control-h) items-center gap-3">
              <Slider
                id={id}
                aria-describedby={describedBy}
                min={PARALLEL_MIN}
                max={PARALLEL_MAX}
                step={1}
                value={[draft.parallel]}
                onValueChange={([value]) => patch({ parallel: value ?? PARALLEL_MIN })}
                aria-label={t('transfers.settings.parallel')}
                className="grow"
              />
              <Badge variant="secondary">
                <Num value={draft.parallel} />
              </Badge>
            </div>
          )}
        </FormField>

        <FormField
          label={t('transfers.settings.partSize')}
          hint={t('transfers.settings.partSizeHint')}
        >
          {({ id, describedBy }) => (
            <Combobox
              id={id}
              aria-describedby={describedBy}
              options={PART_SIZES.map((size) => ({
                value: String(size),
                label: `${String(size)} ${t('transfers.settings.megabytes')}`,
              }))}
              value={String(draft.partSizeMb)}
              onValueChange={(value) => {
                if (value === null) return;
                const parsed = Number.parseInt(value, 10);
                if (parsed !== 8 && parsed !== 16 && parsed !== 64) return;
                patch({ partSizeMb: parsed });
              }}
              aria-label={t('transfers.settings.partSize')}
            />
          )}
        </FormField>

        <FormField
          label={t('transfers.settings.retries')}
          hint={t('transfers.settings.retriesHint')}
        >
          {({ id, describedBy }) => (
            <div className="flex h-(--control-h) items-center gap-3">
              <Slider
                id={id}
                aria-describedby={describedBy}
                min={RETRIES_MIN}
                max={RETRIES_MAX}
                step={1}
                value={[draft.retries]}
                onValueChange={([value]) => patch({ retries: value ?? RETRIES_MIN })}
                aria-label={t('transfers.settings.retries')}
                className="grow"
              />
              <Badge variant="secondary">
                <Num value={draft.retries} />
              </Badge>
            </div>
          )}
        </FormField>

        <FormField
          label={t('transfers.settings.keepIncomplete')}
          hint={t('transfers.settings.keepIncompleteHint')}
        >
          {({ id, describedBy }) => (
            <Combobox
              id={id}
              aria-describedby={describedBy}
              options={KEEP_DAYS_CHOICES.map((days) => ({
                value: String(days),
                label: `${String(days)} ${t('transfers.settings.days')}`,
              }))}
              value={String(draft.keepIncompleteDays)}
              onValueChange={(value) => {
                if (value === null) return;
                patch({ keepIncompleteDays: Number.parseInt(value, 10) });
              }}
              aria-label={t('transfers.settings.keepIncomplete')}
            />
          )}
        </FormField>
      </CardContent>

      <div className="px-(--card-pad)">
        <OptionRow
          label={t('transfers.settings.verifyChecksums')}
          hint={t('transfers.settings.verifyChecksumsHint')}
        >
          <Switch
            checked={draft.verifyChecksums}
            onCheckedChange={(checked) => patch({ verifyChecksums: checked })}
            aria-label={t('transfers.settings.verifyChecksums')}
          />
        </OptionRow>
      </div>

      <FormActions>
        <Button
          variant="outline"
          size="sm"
          className="me-auto"
          disabled={saving}
          onClick={() => setDraft(SETTINGS_DEFAULTS.transfers)}
        >
          {t('transfers.settings.reset')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!dirty || saving}
          onClick={() => setDraft(saved)}
        >
          {tCommon('action.cancel')}
        </Button>
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() =>
            onSave(
              {
                parallel: draft.parallel,
                partSizeMb: draft.partSizeMb,
                verifyChecksums: draft.verifyChecksums,
                keepIncompleteDays: draft.keepIncompleteDays,
                retries: draft.retries,
              },
              () => setDraft(draft),
            )
          }
        >
          {saving ? <Spinner /> : null}
          {tCommon('action.save')}
        </Button>
      </FormActions>
    </Card>
  );
}
