import {
  QUOTA_FILTERS,
  type ListQuotasQuery,
  type QuotaFilter,
  type QuotaRow,
  type QuotaSupport,
} from '@storage-io/contracts';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import {
  BellIcon,
  CircleXIcon,
  DatabaseIcon,
  FileDownIcon,
  GaugeIcon,
  GlobeIcon,
  InfinityIcon,
  InfoIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Bytes,
  Button,
  Combobox,
  DEFAULT_PAGE_SIZE,
  DataTable,
  Dash,
  EmptyState,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  KpiCard,
  METER_CRIT_RATIO,
  METER_WARN_RATIO,
  Meter,
  Num,
  PageHeader,
  Pct,
  SectionCard,
  SegmentedControl,
  Skeleton,
  Sparkline,
  StatusDot,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  meterToneFor,
  type ComboboxOption,
  type SegmentedOption,
} from '@/components/app';
import { fetchQuotasCsv, useQuotas } from '@/features/quotas/api';
import { useServers } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { downloadBlob, timestampedFilename } from '@/lib/csv';
import { useDialogs } from '@/lib/dialogs/useDialogs';
import { useFormat } from '@/lib/format/FormatProvider';

/** Registers the dialog this route owns; /servers and /buckets open it by URL. */
import '@/features/quotas/dialogs/EditQuotaDialog';

/**
 * Bucket size limits and how close each one is. The whole point of the page is the
 * distinction the concept draws and the contract carries: a *hard* limit the
 * storage server enforces, versus an *alert-only* threshold storage-io watches
 * because the provider has no native quota. The enforcement column never guesses —
 * it reads the row's `supported` field.
 *
 * A bucket on an offline server keeps its last known size and its actions are
 * disabled, because writing a quota to a server that is not answering would fail
 * after the operator had already been told it worked.
 */


interface QuotasSearch {
  readonly q?: string;
  readonly serverId?: string;
  readonly filter?: string;
}

function isQuotaFilter(value: unknown): value is QuotaFilter {
  return typeof value === 'string' && (QUOTA_FILTERS as readonly string[]).includes(value);
}

function sparkTone(support: QuotaSupport, ratio: number | null): 'chart-1' | 'chart-4' | 'chart-5' {
  if (support === 'unavailable') return 'chart-1';
  if (ratio !== null && ratio >= METER_CRIT_RATIO) return 'chart-5';
  if (ratio !== null && ratio >= METER_WARN_RATIO) return 'chart-4';
  return 'chart-1';
}

export function QuotasPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomain } = useTranslation('domain');
  const navigate = useNavigate();
  const dialogs = useDialogs();
  const apiError = useApiError();
  const format = useFormat();

  const search = useSearch({ strict: false });
  const query = typeof search.q === 'string' ? search.q : '';
  const filter: QuotaFilter = isQuotaFilter(search.filter) ? search.filter : 'all';
  const serverId = typeof search.serverId === 'string' ? search.serverId : null;

  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  const setSearch = useCallback(
    (next: Partial<QuotasSearch>) => {
      setPagination((state) => ({ ...state, pageIndex: 0 }));
      void navigate({
        to: '/quotas',
        search: (current: Record<string, unknown>) => ({ ...current, ...next }),
        replace: true,
      });
    },
    [navigate],
  );

  const servers = useServers();
  const quotas = useQuotas({
    filter,
    ...(query.length > 0 ? { q: query } : {}),
    ...(serverId === null ? {} : { serverId }),
    page: pagination.pageIndex + 1,
    pageSize: pagination.pageSize,
  });

  const rows = useMemo(() => quotas.data?.items ?? [], [quotas.data]);
  const summary = quotas.data?.summary;

  /** The worst offender drives the banner, because that is the one at risk now. */
  const worst = useMemo(() => {
    const enforced = rows.filter(
      (row) =>
        row.bucket.quota !== null &&
        row.usageRatio !== null &&
        row.usageRatio >= METER_WARN_RATIO &&
        row.supported !== 'unavailable',
    );
    return enforced.sort((left, right) => (right.usageRatio ?? 0) - (left.usageRatio ?? 0)).at(0);
  }, [rows]);

  const serverOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      (servers.data?.items ?? []).map((server) => ({
        value: server.id,
        label: server.name,
        description: server.endpoint,
      })),
    [servers.data],
  );

  const filterOptions = useMemo<readonly SegmentedOption<QuotaFilter>[]>(
    () => QUOTA_FILTERS.map((value) => ({ value, label: t(`quotas.filter.${value}`) })),
    [t],
  );

  const [exporting, setExporting] = useState(false);

  /**
   * The API writes the CSV. `GET /quotas/export.csv` takes the same filters, so the
   * file covers every matching bucket rather than the page being looked at.
   */
  const exportCsv = useCallback(() => {
    setExporting(true);
    const filters: ListQuotasQuery = {
      filter,
      ...(query.length > 0 ? { q: query } : {}),
      ...(serverId === null ? {} : { serverId }),
    };
    fetchQuotasCsv(filters)
      .then((blob) => {
        const filename = timestampedFilename('quotas', 'csv');
        downloadBlob(filename, blob);
        toast.success(t('quotas.export.done'), { description: filename });
      })
      .catch((error: unknown) => {
        apiError.toastError(error, t('quotas.export.failed'));
      })
      .finally(() => setExporting(false));
  }, [apiError, filter, query, serverId, t]);

  const openEdit = useCallback(
    (row: QuotaRow) =>
      dialogs.openHere('edit-quota', {
        server: row.bucket.serverName,
        bucket: row.bucket.name,
      }),
    [dialogs],
  );

  const columns = useMemo<readonly ColumnDef<QuotaRow, unknown>[]>(
    () => [
      {
        id: 'bucket',
        header: () => t('quotas.column.bucket'),
        cell: ({ row }) => {
          const bucket = row.original.bucket;
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
        header: () => t('quotas.column.server'),
        cell: ({ row }) => (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {row.original.bucket.serverName}
          </span>
        ),
      },
      {
        id: 'usage',
        size: 220,
        header: () => t('quotas.column.usage'),
        cell: ({ row }) => {
          const entry = row.original;
          if (entry.supported === 'unavailable') {
            return (
              <div className="flex items-center gap-1.5">
                <Badge variant="danger">
                  <StatusDot tone="err" />
                  {tCommon('state.unavailable')}
                </Badge>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <InfoIcon className="size-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('quotas.unavailableHint', { server: entry.bucket.serverName })}
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          }
          if (entry.bucket.quota === null) {
            return (
              <Badge variant="outline">
                <InfinityIcon />
                {t('quotas.noLimit')}
              </Badge>
            );
          }
          const tone = meterToneFor(entry.usageRatio);
          return (
            <div className="flex items-center gap-2">
              <Meter
                value={entry.usageRatio}
                tone={tone}
                size="lg"
                className="flex-1"
                label={t('quotas.usageMeter', { name: entry.bucket.name })}
              />
              <Pct
                value={entry.usageRatio}
                className={
                  tone === 'crit'
                    ? 'font-semibold text-destructive'
                    : tone === 'warn'
                      ? 'font-semibold text-warning'
                      : 'font-semibold'
                }
              />
            </div>
          );
        },
      },
      {
        id: 'used',
        header: () => t('quotas.column.used'),
        cell: ({ row }) => {
          const entry = row.original;
          return (
            <span className="num text-[0.8125rem]">
              <Bytes value={entry.bucket.sizeBytes} />
              {entry.bucket.quota === null ? null : (
                <span className="text-muted-foreground">
                  {' / '}
                  <Bytes value={entry.bucket.quota.limitBytes} />
                </span>
              )}
            </span>
          );
        },
      },
      {
        id: 'enforcement',
        header: () => t('quotas.column.enforcement'),
        cell: ({ row }) => {
          const entry = row.original;
          if (entry.bucket.quota === null) return <Dash />;
          // The badge states what the *stored* quota is. A server that is
          // unreachable still has its hard limit; only a provider with no native
          // quota (`alert-only`) actually downgrades it to a notification.
          if (entry.bucket.quota.mode === 'hard' && entry.supported !== 'alert-only') {
            return (
              <Badge variant="secondary">
                <ShieldIcon />
                {tDomain('quotaMode.hard')}
              </Badge>
            );
          }
          return (
            <div className="flex items-center gap-1.5">
              <Badge variant="outline">
                <BellIcon />
                {tDomain('quotaMode.alert')}
              </Badge>
              {entry.supported === 'alert-only' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <InfoIcon className="size-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">
                    {t('quotas.alertOnlyHint')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'alertAt',
        header: () => t('quotas.column.alertAt'),
        cell: ({ row }) =>
          row.original.bucket.quota === null ? (
            <Dash />
          ) : (
            <Pct
              value={row.original.bucket.quota.threshold}
              className="text-xs text-muted-foreground"
            />
          ),
      },
      {
        id: 'trend',
        size: 90,
        header: () => t('quotas.column.trend'),
        cell: ({ row }) => {
          const entry = row.original;
          if (entry.trend.length < 2) return <Dash />;
          return (
            <Sparkline
              values={entry.trend}
              tone={sparkTone(entry.supported, entry.usageRatio)}
              filled={false}
              className="h-6 w-20"
              ariaLabel={t('quotas.trendLabel', {
                name: entry.bucket.name,
                from: format.bytes(entry.trend[0] ?? 0),
                to: format.bytes(entry.trend.at(-1) ?? 0),
              })}
            />
          );
        },
      },
      {
        id: 'actions',
        size: 96,
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">{tCommon('table.rowActions')}</span>,
        cell: ({ row }) => {
          const entry = row.original;
          const disabled = entry.supported === 'unavailable';
          if (entry.bucket.quota === null) {
            return (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  openEdit(entry);
                }}
              >
                <PlusIcon />
                {t('quotas.set')}
              </Button>
            );
          }
          return (
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label={t('quotas.editQuotaFor', { name: entry.bucket.name })}
              onClick={(event) => {
                event.stopPropagation();
                openEdit(entry);
              }}
            >
              <PencilIcon />
            </Button>
          );
        },
      },
    ],
    [format, openEdit, t, tCommon, tDomain],
  );

  return (
    <>
      <PageHeader
        title={t('quotas.title')}
        description={t('quotas.description')}
        actions={
          <>
            <Button variant="outline" onClick={exportCsv} disabled={exporting}>
              {exporting ? <Spinner /> : <FileDownIcon />}
              {tCommon('table.exportCsv')}
            </Button>
            <Button onClick={() => dialogs.openHere('edit-quota')}>
              <GaugeIcon />
              {t('quotas.setAQuota')}
            </Button>
          </>
        }
      />

      {worst === undefined ? null : (
        <div className="mb-(--gap-lg)">
          <Alert variant={worst.usageRatio !== null && worst.usageRatio >= METER_CRIT_RATIO ? 'danger' : 'warning'}>
            <TriangleAlertIcon />
            <AlertTitle className="line-clamp-none">
              <span className="font-mono">{worst.bucket.name}</span>{' '}
              <span className="font-normal">
                {worst.bucket.quota?.mode === 'hard'
                  ? t('quotas.banner.nearHard')
                  : t('quotas.banner.nearAlert')}
              </span>
            </AlertTitle>
            <AlertDescription className="block text-xs">
              <span className="num">
                <Bytes value={worst.bucket.sizeBytes} />
                {' / '}
                <Bytes value={worst.bucket.quota?.limitBytes ?? null} />
              </span>{' '}
              ·{' '}
              {worst.bucket.quota?.mode === 'hard'
                ? t('quotas.banner.writesRejected')
                : t('quotas.banner.writesContinue')}
            </AlertDescription>
            <div className="col-start-2 mt-2 sm:absolute sm:end-4 sm:top-1/2 sm:col-start-auto sm:mt-0 sm:-translate-y-1/2">
              <Button variant="outline" size="sm" onClick={() => openEdit(worst)}>
                <PencilIcon />
                {t('quotas.editQuota')}
              </Button>
            </div>
          </Alert>
        </div>
      )}

      <div className="grid gap-(--gap) sm:grid-cols-2 xl:grid-cols-4">
        {quotas.isLoading || summary === undefined ? (
          Array.from({ length: 4 }, (_unused, index) => (
            <Skeleton key={index} className="h-32 rounded-xl" />
          ))
        ) : (
          <>
            <KpiCard
              label={t('quotas.kpi.withQuota')}
              icon={GaugeIcon}
              value={<Num value={summary.withQuota} />}
              suffix={<>/ <Num value={summary.withQuota + summary.unlimited} /></>}
              footer={
                <>
                  <Pct
                    value={
                      summary.withQuota + summary.unlimited === 0
                        ? null
                        : summary.withQuota / (summary.withQuota + summary.unlimited)
                    }
                  />
                  <span>{t('quotas.kpi.ofAllBuckets')}</span>
                </>
              }
            >
              <Meter
                value={
                  summary.withQuota + summary.unlimited === 0
                    ? null
                    : summary.withQuota / (summary.withQuota + summary.unlimited)
                }
                label={t('quotas.kpi.withQuota')}
              />
            </KpiCard>

            <KpiCard
              label={t('quotas.kpi.over90')}
              icon={CircleXIcon}
              value={<Num value={summary.over90} />}
              className={summary.over90 > 0 ? '[&_.num]:text-destructive' : undefined}
              footer={
                summary.over90 > 0 ? (
                  <Badge variant="danger">{t('quotas.kpi.writesAtRisk')}</Badge>
                ) : (
                  <span>{t('quotas.kpi.allClear')}</span>
                )
              }
            />

            <KpiCard
              label={t('quotas.kpi.over80')}
              icon={TriangleAlertIcon}
              value={<Num value={summary.over80} />}
              footer={<span>{t('quotas.kpi.alertsRaised')}</span>}
            />

            <KpiCard
              label={t('quotas.kpi.unlimited')}
              icon={InfinityIcon}
              value={<Num value={summary.unlimited} />}
              footer={<span>{t('quotas.kpi.unlimitedHint')}</span>}
            />
          </>
        )}
      </div>

      <div className="mt-(--gap-lg) mb-(--gap) flex flex-wrap items-center gap-2">
        <InputGroup className="w-full sm:w-64">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setSearch({ q: event.target.value })}
            placeholder={t('quotas.searchPlaceholder')}
            aria-label={t('quotas.searchPlaceholder')}
          />
        </InputGroup>

        <Combobox
          options={serverOptions}
          value={serverId}
          onValueChange={(next) => setSearch({ serverId: next ?? undefined })}
          placeholder={t('quotas.allServers')}
          clearable
          className="w-full sm:w-52"
          aria-label={t('quotas.serverFilter')}
        />

        <SegmentedControl
          options={filterOptions}
          value={filter}
          onValueChange={(next) => setSearch({ filter: next })}
          className="sm:ms-auto"
          aria-label={t('quotas.filter.label')}
        />
      </div>

      <SectionCard
        title={t('quotas.table.title')}
        description={t('quotas.table.description', {
          shown: rows.length,
          total: quotas.data?.total ?? 0,
        })}
        flush
      >
        {quotas.isError ? (
          <EmptyState
            icon={GaugeIcon}
            title={tCommon('state.error')}
            description={apiError.message(quotas.error)}
          />
        ) : (
          <DataTable
            aria-label={t('quotas.table.title')}
            columns={columns}
            data={rows}
            getRowId={(row) => `${row.bucket.serverId}/${row.bucket.name}`}
            loading={quotas.isLoading}
            pagination={pagination}
            onPaginationChange={setPagination}
            total={quotas.data?.total}
            showColumnsMenu
            onRowClick={(row) =>
              void navigate({
                to: '/buckets/$server/$bucket',
                params: { server: row.bucket.serverName, bucket: row.bucket.name },
              })
            }
            emptyState={
              <EmptyState
                icon={GaugeIcon}
                title={
                  query.length > 0 || filter !== 'all' || serverId !== null
                    ? tCommon('state.noResults')
                    : t('quotas.empty.title')
                }
                description={t('quotas.empty.description')}
                action={
                  query.length > 0 || filter !== 'all' || serverId !== null ? (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setSearch({ q: undefined, serverId: undefined, filter: 'all' })
                      }
                    >
                      {tCommon('action.clear')}
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        )}
      </SectionCard>

      <Alert variant="info" className="mt-(--gap)">
        <InfoIcon />
        <AlertTitle>{t('quotas.note.title')}</AlertTitle>
        <AlertDescription>{t('quotas.note.body')}</AlertDescription>
      </Alert>
    </>
  );
}
