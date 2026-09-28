import {
  ACCESS_KEY_EXPIRING_DAYS,
  ACCESS_KEY_FILTERS,
  type AccessKey,
  type AccessKeyFilter,
  type AccessKeyList,
} from '@storage-io/contracts';
import { Outlet, useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef, PaginationState, RowSelectionState } from '@tanstack/react-table';
import {
  BanIcon,
  CopyIcon,
  EllipsisIcon,
  FileDownIcon,
  KeyRoundIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AccessKeyStatusBadge,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  DEFAULT_PAGE_SIZE,
  DataTable,
  Dash,
  selectionColumn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  PageHeader,
  ProviderMark,
  RelativeTime,
  SectionCard,
  SegmentedControl,
  type ComboboxOption,
  type SegmentedOption,
} from '@/components/app';
import {
  fetchAccessKeysCsv,
  useAccessKeyById,
  useAccessKeyBulk,
  useAccessKeys,
  useDeleteAccessKey,
  useUpdateAccessKey,
} from '@/features/iam/api';
import { EditAccessKeyDialog } from '@/features/iam/components/EditAccessKeyDialog';
import { RotateAccessKeyDialog } from '@/features/iam/dialogs/RotateAccessKeyDialog';
import { UnavailableServersAlert } from '@/features/iam/components/UnavailableServersAlert';
import { DAY_MS, msUntil } from '@/features/iam/expiry';
import { useServers } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { useRouteOverlay } from '@/lib/dialogs/route';
import { csvFileName, downloadBlob } from '@/lib/csv/csv';
import { useFormat } from '@/lib/format/FormatProvider';

/** The two dialogs this route owns; the palette and the users page open them by URL. */

/**
 * Every programmatic credential in the installation, on one page.
 *
 * The page is built around the one question that matters operationally: *what is
 * about to stop working?* That is why the expiring banner is above the table rather
 * than a column in it, why "Expiring soon" is a first-class filter with its own
 * count from the server, and why an expiry inside the window is rendered in the
 * warning colour instead of as another relative time.
 *
 * `ACCESS_KEY_EXPIRING_DAYS` comes from the contract, so the banner's wording and
 * the filter the API applies cannot drift apart.
 */

const KEYS_PAGE_SIZE = DEFAULT_PAGE_SIZE;

function isExpiringSoon(key: AccessKey): boolean {
  if (key.expiresAt === null || key.status !== 'active') return false;
  const remaining = msUntil(key.expiresAt);
  return remaining > 0 && remaining <= ACCESS_KEY_EXPIRING_DAYS * DAY_MS;
}

function hasExpired(key: AccessKey): boolean {
  return key.expiresAt !== null && msUntil(key.expiresAt) < 0;
}

function countLabel(
  counts: AccessKeyList['counts'] | undefined,
  value: KeyFilterValue,
  formatNumber: (input: number) => string,
): string | undefined {
  if (counts === undefined) return undefined;
  const count = countFor(counts, value);
  return count === undefined ? undefined : formatNumber(count);
}

function countFor(
  counts: AccessKeyList['counts'],
  value: KeyFilterValue,
): number | undefined {
  switch (value) {
    case 'all':
      return counts.all;
    case 'active':
      return counts.active;
    case 'expiring':
      return counts.expiring;
    case 'disabled':
      return counts.disabled;
    case 'expired':
      return undefined;
    default:
      return undefined;
  }
}

function isAccessKeyFilter(value: unknown): value is AccessKeyFilter {
  return typeof value === 'string' && (ACCESS_KEY_FILTERS as readonly string[]).includes(value);
}

/** "All" is the page's own state, not a contract filter: the API omits `status`. */
type KeyFilterValue = AccessKeyFilter | 'all';
const KEY_FILTER_VALUES: readonly KeyFilterValue[] = ['all', ...ACCESS_KEY_FILTERS];

export function KeysPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const apiError = useApiError();
  const format = useFormat();

  const search = useSearch({ strict: false });
  const query = typeof search.q === 'string' ? search.q : '';
  const serverId = typeof search.serverId === 'string' ? search.serverId : null;
  const filter: KeyFilterValue = isAccessKeyFilter(search.status) ? search.status : 'all';

  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: KEYS_PAGE_SIZE,
  });
  /**
   * Editing and rotating a key are that key's own routes — `/keys/$keyId/edit`
   * and `/keys/$keyId/rotate` — so both are links. The page keeps ownership
   * because both act on the row behind them and on this list's queries.
   */
  const overlay = useRouteOverlay();

  const closeOverlay = useCallback(() => {
    void navigate({ to: '/keys', search: true });
  }, [navigate]);

  const setEditKey = useCallback(
    (key: AccessKey) => {
      void navigate({ to: '/keys/$keyId/edit', params: { keyId: key.id }, search: true });
    },
    [navigate],
  );

  const openRotate = useCallback(
    (key: AccessKey) => {
      void navigate({ to: '/keys/$keyId/rotate', params: { keyId: key.id }, search: true });
    },
    [navigate],
  );
  const [deleteKey, setDeleteKey] = useState<AccessKey | null>(null);
  const [bulkDelete, setBulkDelete] = useState<readonly AccessKey[]>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const servers = useServers();
  const keys = useAccessKeys({
    ...(query.length > 0 ? { q: query } : {}),
    ...(serverId === null ? {} : { serverId }),
    ...(filter === 'all' ? {} : { status: filter }),
    page: pagination.pageIndex + 1,
    pageSize: pagination.pageSize,
  });
  const updateKey = useUpdateAccessKey();
  const keyBulk = useAccessKeyBulk();
  const removeKey = useDeleteAccessKey();

  const items = useMemo(() => keys.data?.items ?? [], [keys.data]);

  /** The key an overlay route names, resolved from its id in one request. */
  const overlayKey = useAccessKeyById(overlay.params.keyId);
  const editKey = overlay.name === 'key-edit' ? (overlayKey.data ?? null) : null;
  const rotateKey = overlay.name === 'key-rotate' ? (overlayKey.data ?? null) : null;
  const counts = keys.data?.counts;

  const setSearch = useCallback(
    (next: Record<string, string | undefined>) => {
      setPagination((state) => ({ ...state, pageIndex: 0 }));
      void navigate({
        to: '/keys',
        search: (current: Record<string, unknown>) => ({ ...current, ...next }),
        replace: true,
      });
    },
    [navigate],
  );

  const serverOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      (servers.data?.items ?? [])
        .filter((server) => server.capabilities.accessKeys === 'supported')
        .map((server) => ({ value: server.id, label: server.name, description: server.endpoint })),
    [servers.data],
  );

  const expirySupportedFor = useCallback(
    (key: AccessKey) =>
      (servers.data?.items ?? []).find((server) => server.id === key.serverId)?.capabilities
        .accessKeyExpiry === 'supported',
    [servers.data],
  );

  const filterOptions = useMemo<readonly SegmentedOption<KeyFilterValue>[]>(
    () =>
      KEY_FILTER_VALUES.map((value) => ({
        value,
        label: t(`keys.filter.${value}`),
        // `expired` has no server-side count (AccessKeyList.counts carries all,
        // active, expiring and disabled), so that tab shows no pill rather than a
        // number the response never gave.
        count: countLabel(counts, value, format.number),
      })),
    [counts, format, t],
  );

  /** The soonest-expiring active key drives the banner: it is the next outage. */
  const expiringSoon = useMemo(() => {
    const soon = items.filter(isExpiringSoon);
    return soon.sort(
      (left, right) => Date.parse(left.expiresAt ?? '') - Date.parse(right.expiresAt ?? ''),
    );
  }, [items]);

  /**
   * A bulk action is one request — `POST /iam/access-keys/bulk` — and it reports
   * a row per key, so a partial failure names what it did not reach.
   */
  const runBulk = useCallback(
    (selected: readonly AccessKey[], action: 'enable' | 'disable' | 'delete', successKey: string) => {
      if (selected.length === 0) return;
      keyBulk.mutate(
        { ids: selected.map((key) => key.id), action },
        {
          onSuccess: (response) => {
            const total = response.results.length;
            const failed = response.results.filter((row) => !row.ok).length;
            if (failed === 0) {
              toast.success(t(successKey), {
                description: t('keys.bulk.applied', { count: total }),
              });
            } else {
              toast.error(t('keys.bulk.partial', { failed, total }));
            }
          },
          onError: (error) => apiError.toastError(error, t('keys.toast.updateFailed')),
          onSettled: () => {
            setBulkDelete([]);
            setRowSelection({});
          },
        },
      );
    },
    [apiError, keyBulk, t],
  );

  const copyId = useCallback(
    (key: AccessKey) => {
      void navigator.clipboard.writeText(key.accessKeyId).then(
        () => toast.success(tCommon('action.copied'), { description: key.accessKeyId }),
        () => toast.error(t('keys.copyFailed')),
      );
    },
    [t, tCommon],
  );

  const disableKey = useCallback(
    (key: AccessKey) => {
      updateKey.mutate(
        { serverId: key.serverId, accessKeyId: key.accessKeyId, status: 'disabled' },
        {
          onSuccess: () =>
            toast.success(t('keys.toast.disabled'), { description: key.accessKeyId }),
          onError: (error) => apiError.toastError(error, t('keys.toast.updateFailed')),
        },
      );
    },
    [apiError, t, updateKey],
  );

  const enableKey = useCallback(
    (key: AccessKey) => {
      updateKey.mutate(
        { serverId: key.serverId, accessKeyId: key.accessKeyId, status: 'active' },
        {
          onSuccess: () => toast.success(t('keys.toast.enabled'), { description: key.accessKeyId }),
          onError: (error) => apiError.toastError(error, t('keys.toast.updateFailed')),
        },
      );
    },
    [apiError, t, updateKey],
  );

  const confirmDelete = useCallback(() => {
    const key = deleteKey;
    if (key === null) return;
    removeKey.mutate(
      { serverId: key.serverId, accessKeyId: key.accessKeyId },
      {
        onSuccess: () => {
          toast.success(t('keys.toast.deleted'), { description: key.accessKeyId });
          setDeleteKey(null);
        },
        onError: (error) => apiError.toastError(error, t('keys.toast.deleteFailed')),
      },
    );
  }, [apiError, deleteKey, removeKey, t]);

  /**
   * The server renders the CSV from the same filters the table is showing, so an
   * export of "expiring keys on minio-prod" is exactly that and not the fifty rows
   * that happen to be on this page.
   */
  const [exporting, setExporting] = useState(false);
  const exportCsv = useCallback(() => {
    setExporting(true);
    fetchAccessKeysCsv({
      ...(query.length > 0 ? { q: query } : {}),
      ...(serverId === null ? {} : { serverId }),
      ...(filter === 'all' ? {} : { status: filter }),
    }).then(
      (blob) => {
        const fileName = csvFileName('access-keys');
        downloadBlob(blob, fileName);
        toast.success(tCommon('table.exportCsv'), { description: fileName });
        setExporting(false);
      },
      (error: unknown) => {
        apiError.toastError(error, t('keys.export.failed'));
        setExporting(false);
      },
    );
  }, [apiError, filter, query, serverId, t, tCommon]);

  const columns = useMemo<readonly ColumnDef<AccessKey, unknown>[]>(
    () => [
      selectionColumn<AccessKey>(),
      {
        id: 'accessKeyId',
        header: () => t('keys.column.accessKeyId'),
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate font-mono text-[0.8125rem] font-medium" dir="ltr">
              {row.original.accessKeyId}
            </span>
          </span>
        ),
      },
      {
        id: 'name',
        header: () => t('keys.column.name'),
        cell: ({ row }) =>
          row.original.name === null ? <Dash /> : <span className="text-[0.8125rem]">{row.original.name}</span>,
      },
      {
        id: 'user',
        header: () => t('keys.column.user'),
        cell: ({ row }) => (
          <span className="truncate font-mono text-xs">{row.original.userName}</span>
        ),
      },
      {
        id: 'server',
        header: () => t('keys.column.server'),
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <ProviderMark provider={row.original.provider} size="sm" />
            <span className="truncate font-mono text-xs text-muted-foreground">
              {row.original.serverName}
            </span>
          </span>
        ),
      },
      {
        id: 'permissions',
        header: () => t('keys.column.permissions'),
        cell: ({ row }) =>
          row.original.restricted ? (
            <Badge variant="info">{t('keys.restricted')}</Badge>
          ) : (
            <Badge variant="outline">{t('keys.inherits')}</Badge>
          ),
      },
      {
        id: 'status',
        header: () => t('keys.column.status'),
        cell: ({ row }) => (
          <AccessKeyStatusBadge
            status={row.original.status}
            expiringSoon={isExpiringSoon(row.original)}
          />
        ),
      },
      {
        id: 'expires',
        header: () => t('keys.column.expires'),
        cell: ({ row }) => {
          const key = row.original;
          if (key.expiresAt === null) {
            return <span className="text-xs text-muted-foreground">{tCommon('state.never')}</span>;
          }
          const expired = hasExpired(key);
          return (
            <RelativeTime
              value={key.expiresAt}
              className={
                expired
                  ? 'text-xs text-destructive'
                  : isExpiringSoon(key)
                    ? 'text-xs font-medium text-warning'
                    : 'text-xs text-muted-foreground'
              }
            />
          );
        },
      },
      {
        id: 'lastUsed',
        header: () => t('keys.column.lastUsed'),
        cell: ({ row }) =>
          row.original.lastUsedAt === null ? (
            <Dash />
          ) : (
            <RelativeTime value={row.original.lastUsedAt} className="text-xs text-muted-foreground" />
          ),
      },
      {
        id: 'actions',
        size: 56,
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">{tCommon('table.rowActions')}</span>,
        cell: ({ row }) => {
          const key = row.original;
          return (
            <KeyRowMenu
              accessKey={key}
              onCopyId={() => copyId(key)}
              onEdit={() => setEditKey(key)}
              onRotate={() => openRotate(key)}
              onDisable={() => disableKey(key)}
              onEnable={() => enableKey(key)}
              onDelete={() => setDeleteKey(key)}
            />
          );
        },
      },
    ],
    [copyId, disableKey, enableKey, openRotate, setEditKey, t, tCommon],
  );

  const hasFilters = query.length > 0 || serverId !== null || filter !== 'all';

  return (
    <>
      <PageHeader
        title={t('keys.title')}
        description={t('keys.description')}
        actions={
          <>
            <Button variant="outline" onClick={exportCsv} disabled={exporting}>
              <FileDownIcon />
              {tCommon('table.exportCsv')}
            </Button>
            <Button onClick={() => void navigate({ to: '/keys/new', search: true })}>
              <PlusIcon />
              {t('keys.create.action')}
            </Button>
          </>
        }
      />

      <UnavailableServersAlert unavailable={keys.data?.unavailable ?? []} />

      {expiringSoon.length === 0 ? null : (
        <Alert variant="warning" className="mb-(--gap)">
          <TriangleAlertIcon />
          <AlertTitle>
            {t('keys.expiringBanner.title', {
              count: expiringSoon.length,
              days: ACCESS_KEY_EXPIRING_DAYS,
            })}
          </AlertTitle>
          <AlertDescription className="block font-mono text-xs" dir="ltr">
            {expiringSoon
              .slice(0, 3)
              .map((key) => `${key.accessKeyId} · ${key.userName} · ${key.serverName}`)
              .join('  ·  ')}
          </AlertDescription>
          <div className="col-start-2 mt-2 sm:absolute sm:end-4 sm:top-1/2 sm:col-start-auto sm:mt-0 sm:-translate-y-1/2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const first = expiringSoon[0];
                if (first === undefined) return;
                openRotate(first);
              }}
            >
              <RotateCwIcon />
              {t('keys.rotateNow')}
            </Button>
          </div>
        </Alert>
      )}

      <div className="mb-(--gap) flex flex-wrap items-center gap-2">
        <InputGroup className="w-full sm:w-72">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setSearch({ q: event.target.value })}
            placeholder={t('keys.searchPlaceholder')}
            aria-label={t('keys.searchPlaceholder')}
          />
        </InputGroup>

        <Combobox
          options={serverOptions}
          value={serverId}
          onValueChange={(next) => setSearch({ serverId: next ?? undefined })}
          placeholder={t('keys.allServers')}
          clearable
          className="w-full sm:w-52"
          aria-label={t('keys.serverFilter')}
        />

        {/*
          Five segments plus their counts are wider than a phone. The control
          itself is `w-fit` by design, so the *row* scrolls rather than the page:
          a page-level horizontal scrollbar at 375px was the symptom.
        */}
        <div className="-mx-1 w-full overflow-x-auto px-1 sm:mx-0 sm:ms-auto sm:w-auto sm:px-0">
          <SegmentedControl
            options={filterOptions}
            value={filter}
            onValueChange={(next) => setSearch({ status: next === 'all' ? undefined : next })}
            aria-label={t('keys.filter.label')}
          />
        </div>
      </div>

      <SectionCard flush>
        {keys.isError ? (
          <EmptyState
            icon={KeyRoundIcon}
            title={tCommon('state.error')}
            description={apiError.message(keys.error)}
          />
        ) : (
          <DataTable
            aria-label={t('keys.title')}
            columns={columns}
            data={items}
            getRowId={(key) => key.id}
            loading={keys.isLoading}
            pagination={pagination}
            onPaginationChange={setPagination}
            total={keys.data?.total}
            rowSelection={rowSelection}
            onRowSelectionChange={setRowSelection}
            showColumnsMenu
            bulkActions={({ selectedRows }) => (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={keyBulk.isPending}
                  onClick={() => runBulk(selectedRows, 'disable', 'keys.toast.disabled')}
                >
                  <BanIcon />
                  {t('keys.disable')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={keyBulk.isPending}
                  onClick={() => runBulk(selectedRows, 'enable', 'keys.toast.enabled')}
                >
                  <PlayIcon />
                  {t('keys.enable')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={keyBulk.isPending}
                  onClick={() => setBulkDelete(selectedRows)}
                >
                  <Trash2Icon />
                  {tCommon('action.delete')}
                </Button>
              </>
            )}
            emptyState={
              <EmptyState
                icon={KeyRoundIcon}
                title={hasFilters ? tCommon('state.noResults') : t('keys.empty.title')}
                description={t('keys.empty.description')}
                action={
                  hasFilters ? (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setSearch({ q: undefined, serverId: undefined, status: undefined })
                      }
                    >
                      {tCommon('action.clear')}
                    </Button>
                  ) : (
                    <Button onClick={() => void navigate({ to: '/keys/new', search: true })}>
                      <PlusIcon />
                      {t('keys.create.action')}
                    </Button>
                  )
                }
              />
            }
          />
        )}
      </SectionCard>

      {/* `/keys/new` renders here; edit and rotate are driven by their routes. */}
      <Outlet />

      {editKey === null ? null : (
        <EditAccessKeyDialog
          accessKey={editKey}
          expirySupported={expirySupportedFor(editKey)}
          onClose={closeOverlay}
        />
      )}

      {rotateKey === null ? null : (
        <RotateAccessKeyDialog accessKey={rotateKey} onClose={closeOverlay} />
      )}

      <ConfirmDialog
        open={bulkDelete.length > 0}
        onOpenChange={(open) => {
          if (!open) setBulkDelete([]);
        }}
        destructive
        title={t('keys.bulk.deleteTitle', { count: bulkDelete.length })}
        description={t('keys.bulk.deleteDescription')}
        confirmLabel={tCommon('action.delete')}
        busy={keyBulk.isPending}
        onConfirm={() => runBulk(bulkDelete, 'delete', 'keys.toast.deleted')}
      />

      <ConfirmDialog
        open={deleteKey !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteKey(null);
        }}
        title={t('keys.delete.title')}
        description={t('keys.delete.description')}
        confirmValue={deleteKey?.accessKeyId}
        confirmLabel={tCommon('action.delete')}
        destructive
        busy={removeKey.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}

function KeyRowMenu({
  accessKey,
  onCopyId,
  onEdit,
  onRotate,
  onDisable,
  onEnable,
  onDelete,
}: {
  readonly accessKey: AccessKey;
  readonly onCopyId: () => void;
  readonly onEdit: () => void;
  readonly onRotate: () => void;
  readonly onDisable: () => void;
  readonly onEnable: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  return (
    <RowMenu label={t('keys.actionsFor', { id: accessKey.accessKeyId })}>
      <MenuItem icon={CopyIcon} onSelect={onCopyId} label={t('keys.copyId')} />
      <MenuItem icon={PencilIcon} onSelect={onEdit} label={t('keys.edit.action')} />
      <MenuItem
        icon={RotateCwIcon}
        onSelect={onRotate}
        label={t('keys.rotate.action')}
        disabled={accessKey.status === 'expired'}
      />
      {accessKey.status === 'disabled' ? (
        <MenuItem icon={PlayIcon} onSelect={onEnable} label={t('keys.enable')} />
      ) : (
        <MenuItem
          icon={BanIcon}
          onSelect={onDisable}
          label={t('keys.disable')}
          disabled={accessKey.status === 'expired'}
        />
      )}
      <MenuSeparator />
      <MenuItem
        icon={Trash2Icon}
        onSelect={onDelete}
        label={tCommon('action.delete')}
        destructive
      />
    </RowMenu>
  );
}

/* The tiny menu wrappers keep the row cells readable. */

function RowMenu({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onSelect,
  disabled = false,
  destructive = false,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      disabled={disabled}
      variant={destructive ? 'destructive' : 'default'}
    >
      <Icon />
      {label}
    </DropdownMenuItem>
  );
}

function MenuSeparator() {
  return <DropdownMenuSeparator />;
}
