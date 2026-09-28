import {
  BUCKET_SORTS,
  type Bucket,
  type BucketAccess,
  type BucketRef,
  type BucketSort,
} from '@storage-io/contracts';
import { Outlet, useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef, RowSelectionState, VisibilityState } from '@tanstack/react-table';
import {
  CopyIcon,
  DatabaseIcon,
  EllipsisIcon,
  EraserIcon,
  FileDownIcon,
  FolderOpenIcon,
  GaugeIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  ShieldCheckIcon,
  TagsIcon,
  TimerIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/app/Button';
import { Card, CardContent } from '@/components/app/Card';
import { Combobox, type ComboboxOption } from '@/components/app/Combobox';
import { DataTable, DEFAULT_PAGE_SIZE, selectionColumn } from '@/components/app/DataTable';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/app/DropdownMenu';
import { EmptyState } from '@/components/app/EmptyState';
import { Bytes, Num } from '@/components/app/Format';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/app/InputGroup';
import { PageHeader } from '@/components/app/PageHeader';
import { ProviderMark } from '@/components/app/ProviderMark';
import { Spinner } from '@/components/app/Spinner';
import { useServerList } from '@/features/shell/api';
import { toastProblem } from '@/lib/api/problems';
import { downloadBlob, timestampedFilename } from '@/lib/csv';
import { fetchBucketsCsv, s3Uri, useBucketBulkAction, useBuckets } from './api';
import { BUCKET_HIDDEN_COLUMNS, bucketColumns } from './columns';
import { BucketAccessDialog } from './dialogs/BucketAccessDialog';
import { BucketQuotaDialog } from './dialogs/BucketQuotaDialog';
import { BucketTagsDialog } from './dialogs/BucketTagsDialog';
import { DeleteBucketDialog } from './dialogs/DeleteBucketDialog';
import { EmptyBucketDialog } from './dialogs/EmptyBucketDialog';
import { LifecycleRuleDialog } from './dialogs/LifecycleRuleDialog';
import { reportBulkResult } from './dialogs/bulkResult';

/**
 * `/buckets` — every bucket on every server in one list.
 *
 * The filters, the sort and the page live in the URL, so a filtered list is a
 * link an operator can send to a colleague and the Back button works. The search
 * box is the one exception: it is local state pushed into the URL on a debounce,
 * because a history entry per keystroke is useless.
 *
 * Selection does NOT live in the URL. It is per-visit state that a reload should
 * not restore, and `DataTable` keys it by `serverId/name` so it survives a
 * refetch.
 */

const SEARCH_DEBOUNCE_MS = 300;

type DialogKind = 'quota' | 'tags' | 'access' | 'delete' | 'empty' | 'lifecycle' | null;

interface BucketsSearch {
  readonly q?: string;
  readonly server?: string;
  readonly access?: string;
  readonly sort?: string;
  readonly page?: string | number;
}

function asSort(value: unknown): BucketSort {
  const candidate = typeof value === 'string' ? value : '';
  return (BUCKET_SORTS as readonly string[]).includes(candidate) ? (candidate as BucketSort) : 'size';
}

function asAccess(value: unknown): BucketAccess | undefined {
  if (value === 'private' || value === 'public-read' || value === 'custom') return value;
  return undefined;
}

function asPage(value: unknown): number {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 ? value : 1;
  if (typeof value !== 'string') return 1;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

export function BucketsPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomain } = useTranslation('domain');
  const navigate = useNavigate();

  const search: BucketsSearch = useSearch({ strict: false });
  const servers = useServerList();

  const urlQuery = typeof search.q === 'string' ? search.q : '';
  const serverFilter = typeof search.server === 'string' ? search.server : undefined;
  const accessFilter = asAccess(search.access);
  const sort = asSort(search.sort);
  const page = asPage(search.page);

  /**
   * Writes one filter into the URL. `page` resets on every other change, because
   * page 7 of a list filtered to three rows is an empty screen.
   */
  const setFilter = useCallback(
    (patch: Readonly<Record<string, string | undefined>>, keepPage = false) => {
      void navigate({
        to: '/buckets',
        search: (previous: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...previous, ...patch };
          if (!keepPage) delete next.page;
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === '') delete next[key];
          }
          return next;
        },
        replace: true,
      });
    },
    [navigate],
  );

  const [searchText, setSearchText] = useState(urlQuery);
  useEffect(() => {
    if (searchText === urlQuery) return;
    const timer = window.setTimeout(
      () => setFilter({ q: searchText === '' ? undefined : searchText }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [searchText, urlQuery, setFilter]);

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    ...BUCKET_HIDDEN_COLUMNS,
  });
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [rowTarget, setRowTarget] = useState<Bucket | null>(null);
  const [exporting, setExporting] = useState(false);

  const filters = useMemo(
    () => ({
      q: urlQuery === '' ? undefined : urlQuery,
      serverId: serverFilter,
      access: accessFilter,
      sort,
      page,
      pageSize: DEFAULT_PAGE_SIZE,
    }),
    [urlQuery, serverFilter, accessFilter, sort, page],
  );

  const buckets = useBuckets(filters);
  const bulk = useBucketBulkAction();

  const columns = useMemo(
    () => [
      selectionColumn<Bucket>(),
      ...bucketColumns({ t, tDomain, tCommon }),
      rowMenuColumn({
        t,
        tCommon,
        onAction: (action, bucket) => {
          setRowTarget(bucket);
          switch (action) {
            case 'browse':
              void navigate({
                to: '/buckets/$bucketId/browse/$',
                params: { bucketId: bucket.id, _splat: '' },
              });
              return;
            case 'settings':
              void navigate({ to: '/buckets/$bucketId', params: { bucketId: bucket.id } });
              return;
            case 'copy-uri':
              void copyToClipboard(s3Uri(bucket.name), tCommon('action.copied'));
              return;
            case 'quota':
              setDialog('quota');
              return;
            case 'access':
              setDialog('access');
              return;
            case 'empty':
              setDialog('empty');
              return;
            case 'delete':
              setDialog('delete');
              return;
          }
        },
      }),
    ],
    [t, tDomain, tCommon, navigate],
  );

  const selectedRefs = useCallback(
    (rows: readonly Bucket[]): readonly BucketRef[] =>
      rows.map((row) => ({ serverId: row.serverId, bucket: row.name })),
    [],
  );

  const serverOptions = useMemo<readonly ComboboxOption[]>(
    () => [
      { value: '', label: t('buckets.toolbar.allServers') },
      ...(servers.data?.items ?? []).map((server) => ({
        value: server.id,
        label: server.name,
        icon: <ProviderMark provider={server.provider} size="sm" />,
        keywords: [server.provider],
      })),
    ],
    [servers.data, t],
  );

  const accessOptions = useMemo<readonly ComboboxOption[]>(
    () => [
      { value: '', label: t('buckets.toolbar.anyAccess') },
      { value: 'private', label: tDomain('access.private') },
      { value: 'public-read', label: tDomain('access.public-read') },
      { value: 'custom', label: tDomain('access.custom') },
    ],
    [t, tDomain],
  );

  const sortOptions = useMemo<readonly ComboboxOption[]>(
    () => BUCKET_SORTS.map((value) => ({ value, label: t(`buckets.sort.${value}`) })),
    [t],
  );

  /**
   * The API writes the CSV: `GET /buckets/export.csv` applies the same filters and
   * streams every matching bucket, so the file is not limited to the page on screen.
   */
  async function exportCsv(): Promise<void> {
    setExporting(true);
    try {
      const blob = await fetchBucketsCsv(filters);
      const filename = timestampedFilename('buckets', 'csv');
      downloadBlob(filename, blob);
      toast.success(t('buckets.export.started'), { description: filename });
    } catch (error) {
      toastProblem(error, tCommon, t('buckets.export.failed'));
    } finally {
      setExporting(false);
    }
  }

  const summary = buckets.data?.summary;
  const selectedBuckets = useMemo(() => {
    const items = buckets.data?.items ?? [];
    return items.filter((item) => rowSelection[`${item.serverId}/${item.name}`] === true);
  }, [buckets.data, rowSelection]);

  /** One bucket for a row action, or the whole selection for a bulk action. */
  const dialogTargets: readonly BucketRef[] =
    rowTarget === null
      ? selectedRefs(selectedBuckets)
      : [{ serverId: rowTarget.serverId, bucket: rowTarget.name }];

  function closeDialog(): void {
    setDialog(null);
    setRowTarget(null);
  }

  return (
    <>
      <div className="hero-glow" />
      <PageHeader
        title={t('buckets.title')}
        description={t('buckets.description')}
        actions={
          <>
            <Button variant="outline" onClick={() => void exportCsv()} disabled={exporting}>
              {exporting ? <Spinner /> : <FileDownIcon />}
              {t('buckets.export.action')}
            </Button>
            <Button onClick={() => void navigate({ to: '/buckets/new' })}>
              <PlusIcon />
              {t('buckets.create.title')}
            </Button>
          </>
        }
      />

      <Card className="mb-(--gap)">
        <CardContent className="flex flex-wrap gap-x-12 gap-y-3">
          <SummaryStat label={t('buckets.summary.buckets')}>
            <Num value={summary?.buckets ?? null} />
          </SummaryStat>
          <SummaryStat label={t('buckets.summary.stored')}>
            <Bytes value={summary?.sizeBytes ?? null} />
          </SummaryStat>
          <SummaryStat label={t('buckets.summary.objects')}>
            <Num value={summary?.objects ?? null} compact />
          </SummaryStat>
          <SummaryStat label={t('buckets.summary.withQuota')}>
            <Num value={summary?.withQuota ?? null} />
          </SummaryStat>
          <SummaryStat label={t('buckets.summary.nearQuota')} tone="warning">
            <Num value={summary?.nearQuota ?? null} />
          </SummaryStat>
          <SummaryStat label={t('buckets.summary.public')}>
            <Num value={summary?.public ?? null} />
          </SummaryStat>
        </CardContent>
      </Card>

      <DataTable
        aria-label={t('buckets.title')}
        columns={columns}
        data={buckets.data?.items ?? []}
        getRowId={(bucket) => `${bucket.serverId}/${bucket.name}`}
        loading={buckets.isLoading}
        total={buckets.data?.total}
        pagination={{ pageIndex: page - 1, pageSize: DEFAULT_PAGE_SIZE }}
        onPaginationChange={(updater) => {
          const current = { pageIndex: page - 1, pageSize: DEFAULT_PAGE_SIZE };
          const next = typeof updater === 'function' ? updater(current) : updater;
          setFilter({ page: String(next.pageIndex + 1) }, true);
        }}
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={setColumnVisibility}
        showColumnsMenu
        emptyState={
          <EmptyState
            icon={DatabaseIcon}
            title={t('buckets.empty.title')}
            description={t('buckets.empty.description')}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearchText('');
                    setFilter({ q: undefined, server: undefined, access: undefined });
                  }}
                >
                  {t('buckets.empty.reset')}
                </Button>
                <Button onClick={() => void navigate({ to: '/buckets/new' })}>
                  <PlusIcon />
                  {t('buckets.create.title')}
                </Button>
              </div>
            }
          />
        }
        toolbar={
          <>
            <InputGroup className="w-full sm:w-72">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder={t('buckets.toolbar.search')}
                aria-label={t('buckets.toolbar.search')}
              />
            </InputGroup>
            <Combobox
              options={serverOptions}
              value={serverFilter ?? ''}
              onValueChange={(value) => setFilter({ server: value ?? undefined })}
              aria-label={t('buckets.toolbar.allServers')}
              className="w-44"
            />
            <Combobox
              options={accessOptions}
              value={accessFilter ?? ''}
              onValueChange={(value) => setFilter({ access: value ?? undefined })}
              aria-label={t('buckets.toolbar.anyAccess')}
              className="w-40"
            />
          </>
        }
        toolbarActions={
          <>
            <span className="text-[0.8125rem] text-muted-foreground">
              {t('buckets.toolbar.sort')}
            </span>
            <Combobox
              options={sortOptions}
              value={sort}
              onValueChange={(value) => setFilter({ sort: value ?? 'size' })}
              aria-label={t('buckets.toolbar.sortLabel')}
              className="w-52"
            />
          </>
        }
        bulkActions={({ selectedRows }) => (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRowTarget(null);
                setDialog('quota');
              }}
            >
              <GaugeIcon />
              {t('buckets.bulk.setQuota')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRowTarget(null);
                setDialog('lifecycle');
              }}
            >
              <TimerIcon />
              {t('buckets.bulk.applyLifecycleRule')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRowTarget(null);
                setDialog('tags');
              }}
            >
              <TagsIcon />
              {t('buckets.bulk.editTags')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRowTarget(null);
                setDialog('access');
              }}
            >
              <ShieldCheckIcon />
              {t('buckets.accessDialog.title')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={selectedRows.length === 0}
              onClick={() => {
                setRowTarget(null);
                setDialog('delete');
              }}
            >
              <Trash2Icon />
              {t('buckets.bulk.delete')}
            </Button>
          </>
        )}
      />

      <BucketQuotaDialog
        open={dialog === 'quota'}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        buckets={dialogTargets}
        initial={
          rowTarget?.quota == null
            ? null
            : {
                limitBytes: rowTarget.quota.limitBytes,
                mode: rowTarget.quota.mode,
                threshold: rowTarget.quota.threshold,
              }
        }
        onSaved={() => setRowSelection({})}
      />

      <BucketTagsDialog
        open={dialog === 'tags'}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        buckets={dialogTargets}
        onSaved={() => setRowSelection({})}
      />

      <BucketAccessDialog
        open={dialog === 'access'}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        buckets={dialogTargets}
        initial={rowTarget?.access === 'public-read' ? 'public-read' : 'private'}
        onSaved={() => setRowSelection({})}
      />

      <DeleteBucketDialog
        open={dialog === 'delete'}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        buckets={dialogTargets}
        objectCount={rowTarget?.objects ?? null}
        onDeleted={() => setRowSelection({})}
      />

      {rowTarget === null ? null : (
        <EmptyBucketDialog
          open={dialog === 'empty'}
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
          bucket={{ serverId: rowTarget.serverId, bucket: rowTarget.name }}
          objectCount={rowTarget.objects}
          sizeBytes={rowTarget.sizeBytes}
        />
      )}

      <LifecycleRuleDialog
        open={dialog === 'lifecycle'}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        rule={null}
        existingIds={[]}
        busy={bulk.isPending}
        onSubmit={(rule) => {
          bulk.mutate(
            { buckets: [...dialogTargets], action: 'lifecycle-rule', payload: rule },
            {
              onSuccess: (response) => {
                reportBulkResult(response, t, 'buckets.bulk');
                closeDialog();
                setRowSelection({});
              },
              onError: (error) => toastProblem(error, tCommon, t('bucket.lifecycle.saved')),
            },
          );
        }}
      />

      {/* `/buckets/new` renders here. */}
      <Outlet />
    </>
  );
}

function SummaryStat({
  label,
  tone,
  children,
}: {
  readonly label: string;
  readonly tone?: 'warning';
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <span
        className={
          tone === 'warning'
            ? 'text-xl font-semibold text-warning-foreground'
            : 'text-xl font-semibold'
        }
      >
        {children}
      </span>
      <span className="text-[0.8125rem] text-muted-foreground">{label}</span>
    </div>
  );
}

/* ----------------------------- the row menu ----------------------------- */

type RowAction = 'browse' | 'settings' | 'copy-uri' | 'quota' | 'access' | 'empty' | 'delete';

function rowMenuColumn({
  t,
  tCommon,
  onAction,
}: {
  readonly t: (key: string) => string;
  readonly tCommon: (key: string) => string;
  readonly onAction: (action: RowAction, bucket: Bucket) => void;
}): ColumnDef<Bucket, unknown> {
  return {
    id: 'actions',
    size: 48,
    enableSorting: false,
    enableHiding: false,
    header: () => <span className="sr-only">{tCommon('table.rowActions')}</span>,
    cell: ({ row }) => (
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('buckets.row.actions')}
              onClick={(event) => event.stopPropagation()}
            >
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => onAction('browse', row.original)}>
              <FolderOpenIcon />
              {t('buckets.row.browse')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('settings', row.original)}>
              <Settings2Icon />
              {t('buckets.row.settings')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('copy-uri', row.original)}>
              <CopyIcon />
              {t('buckets.row.copyUri')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('quota', row.original)}>
              <GaugeIcon />
              {t('buckets.row.editQuota')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('access', row.original)}>
              <ShieldCheckIcon />
              {t('buckets.row.accessPolicy')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onAction('empty', row.original)}>
              <EraserIcon />
              {t('buckets.row.empty')}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => onAction('delete', row.original)}>
              <Trash2Icon />
              {t('buckets.row.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ),
  };
}

/** Clipboard writes fail in an insecure context; say so rather than pretending. */
async function copyToClipboard(value: string, okMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(okMessage, { description: value });
  } catch {
    toast.error(okMessage, { description: value });
  }
}
