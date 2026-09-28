import {
  S3_USER_STATUSES,
  type S3Group,
  type S3User,
  type S3UserStatus,
} from '@storage-io/contracts';
import { Link, Outlet, useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef, PaginationState, RowSelectionState } from '@tanstack/react-table';
import {
  BanIcon,
  CopyIcon,
  EllipsisIcon,
  FileDownIcon,
  InfoIcon,
  KeyRoundIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SquarePenIcon,
  Trash2Icon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  FormField,
  InitialsAvatar,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Num,
  PageHeader,
  ProviderMark,
  RelativeTime,
  SectionCard,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  UserStatusBadge,
  selectionColumn,
  type ComboboxOption,
} from '@/components/app';
import {
  fetchIamUsersCsv,
  useDeleteIamGroup,
  useIamGroups,
  useIamPolicies,
  useIamGroupById,
  useIamUserById,
  useIamUserBulk,
  useIamUsers,
} from '@/features/iam/api';
import { UnavailableServersAlert } from '@/features/iam/components/UnavailableServersAlert';
import { UserSheet } from '@/features/iam/components/UserSheet';
import { CreateS3GroupDialog } from '@/features/iam/dialogs/CreateS3GroupDialog';
import { useServers } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { routeState, useRouteOverlay } from '@/lib/dialogs/route';
import { csvFileName, downloadBlob } from '@/lib/csv/csv';
import { useFormat } from '@/lib/format/FormatProvider';

/** The two dialogs this route owns. */
import '@/features/iam/dialogs/CreateS3UserDialog';

/**
 * S3 users and groups, aggregated across every server whose driver has IAM.
 *
 * The info alert at the top is not decoration: the single most common
 * misunderstanding about this screen is that these are storage-io logins. They are
 * not — storage-io has one administrator, from the environment, and every row here
 * is an IAM user on one storage server.
 *
 * **Known gap, reported rather than hidden:** the contract has no bulk IAM
 * endpoint. `POST /buckets/bulk` exists for buckets; there is no
 * `POST /iam/users/bulk`. The bulk bar therefore issues one request per selected
 * user and reports a per-user result, which is the same shape the bulk bucket
 * endpoint returns. That loop is a deliberate, bounded stopgap (it can only ever
 * cover one page of selected rows) and the endpoint is what should replace it.
 */

const USERS_PAGE_SIZE = DEFAULT_PAGE_SIZE;

type UsersTab = 'users' | 'groups';

function isUsersTab(value: unknown): value is UsersTab {
  return value === 'users' || value === 'groups';
}

function isUserStatus(value: unknown): value is S3UserStatus {
  return typeof value === 'string' && (S3_USER_STATUSES as readonly string[]).includes(value);
}

export function UsersPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomain } = useTranslation('domain');
  const navigate = useNavigate();
  const apiError = useApiError();
  const format = useFormat();

  const search = useSearch({ strict: false });
  const tab: UsersTab = isUsersTab(search.tab) ? search.tab : 'users';
  const query = typeof search.q === 'string' ? search.q : '';
  const serverId = typeof search.serverId === 'string' ? search.serverId : null;
  const status = isUserStatus(search.status) ? search.status : null;
  const groupQuery = typeof search.gq === 'string' ? search.gq : '';

  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: USERS_PAGE_SIZE,
  });
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  /**
   * The user sheet and the group dialog are routes — `/users/$userId` and
   * `/users/groups/$groupId` — so "show me this user" is a link. They act on the
   * row behind them, so this page keeps ownership and the route says which
   * overlay and which id.
   */
  const overlay = useRouteOverlay();
  const closeOverlay = useCallback(() => {
    void navigate({ to: '/users', search: true });
  }, [navigate]);

  const setOpenUser = useCallback(
    (user: S3User) => {
      void navigate({ to: '/users/$userId', params: { userId: user.id }, search: true });
    },
    [navigate],
  );

  const openGroup = useCallback(
    (group: S3Group) => {
      void navigate({ to: '/users/groups/$groupId', params: { groupId: group.id }, search: true });
    },
    [navigate],
  );
  const [deleteUsers, setDeleteUsers] = useState<readonly S3User[]>([]);
  const [attachTo, setAttachTo] = useState<readonly S3User[]>([]);
  const [deleteGroup, setDeleteGroup] = useState<S3Group | null>(null);

  const servers = useServers();
  const users = useIamUsers({
    ...(query.length > 0 ? { q: query } : {}),
    ...(serverId === null ? {} : { serverId }),
    ...(status === null ? {} : { status }),
    page: pagination.pageIndex + 1,
    pageSize: pagination.pageSize,
  });
  const groups = useIamGroups({
    ...(groupQuery.length > 0 ? { q: groupQuery } : {}),
    ...(serverId === null ? {} : { serverId }),
  });
  const policies = useIamPolicies(serverId === null ? {} : { serverId });
  const userBulk = useIamUserBulk();
  const removeGroup = useDeleteIamGroup();

  const items = useMemo(() => users.data?.items ?? [], [users.data]);
  const groupItems = useMemo(() => groups.data?.items ?? [], [groups.data]);

  /**
   * The entity behind an overlay route, resolved from its id in one request
   * rather than looked up in the list: a link to a user has to work whatever
   * filters this list happens to carry, and on a cold load there is no list yet.
   */
  const overlayUser = useIamUserById(
    overlay.name === 'user-sheet' ? overlay.params.userId : undefined,
  );
  const overlayGroup = useIamGroupById(
    overlay.name === 'group-edit' ? overlay.params.groupId : undefined,
  );
  const openUser = overlayUser.data ?? null;
  const openGroupEntity = overlayGroup.data ?? null;

  const setSearch = useCallback(
    (next: Record<string, string | undefined>) => {
      setPagination((state) => ({ ...state, pageIndex: 0 }));
      void navigate({
        to: '/users',
        search: (current: Record<string, unknown>) => ({ ...current, ...next }),
        replace: true,
      });
    },
    [navigate],
  );

  const serverOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      (servers.data?.items ?? [])
        .filter((server) => server.capabilities.iamUsers === 'supported')
        .map((server) => ({ value: server.id, label: server.name, description: server.endpoint })),
    [servers.data],
  );

  const statusOptions = useMemo<readonly ComboboxOption<S3UserStatus>[]>(
    () => S3_USER_STATUSES.map((value) => ({ value, label: tDomain(`userStatus.${value}`) })),
    [tDomain],
  );

  const hasFilters = query.length > 0 || serverId !== null || status !== null;

  const resetFilters = useCallback(
    () => setSearch({ q: undefined, serverId: undefined, status: undefined }),
    [setSearch],
  );

  const copyArn = useCallback(
    (user: S3User) => {
      const arn = `arn:aws:iam:::user/${user.name}`;
      void navigator.clipboard.writeText(arn).then(
        () => toast.success(tCommon('action.copied'), { description: arn }),
        () => toast.error(t('keys.copyFailed')),
      );
    },
    [t, tCommon],
  );

  /**
   * One request per user, because `/iam/users/bulk` does not exist. Bounded by the
   * selection on screen; a per-user failure is reported rather than swallowed.
   */
  /**
   * Reports one bulk response: a success toast when every row came back ok, and
   * the count of rows the API could not reach otherwise. `results` has one entry
   * per target, so "partial" is a fact rather than a guess.
   */
  const reportBulk = useCallback(
    (results: readonly { readonly ok: boolean }[], successKey: string) => {
      const total = results.length;
      const failed = results.filter((row) => !row.ok).length;
      if (failed === 0) {
        toast.success(t(successKey), { description: t('users.bulk.applied', { count: total }) });
        return;
      }
      toast.error(t('users.bulk.partial', { failed, total }));
    },
    [t],
  );

  /**
   * One request for the whole selection — `POST /iam/users/bulk` — not a loop of
   * one request per user. Forty selected users used to be forty requests, forty
   * cache invalidations and no way to say which of them failed.
   */
  const setStatusForMany = useCallback(
    (selected: readonly S3User[], next: 'enabled' | 'disabled') => {
      if (selected.length === 0) return;
      userBulk.mutate(
        { ids: selected.map((user) => user.id), action: next === 'enabled' ? 'enable' : 'disable' },
        {
          onSuccess: (response) =>
            reportBulk(
              response.results,
              next === 'enabled' ? 'users.toast.enabled' : 'users.toast.disabled',
            ),
          onError: (error) => apiError.toastError(error, t('users.toast.statusFailed')),
        },
      );
    },
    [apiError, reportBulk, t, userBulk],
  );

  /** Server-rendered, from the same filters the table shows. */
  const [exporting, setExporting] = useState(false);
  const exportCsv = useCallback(() => {
    setExporting(true);
    fetchIamUsersCsv({
      ...(query.length > 0 ? { q: query } : {}),
      ...(serverId === null ? {} : { serverId }),
      ...(status === null ? {} : { status }),
    }).then(
      (blob) => {
        const fileName = csvFileName('s3-users');
        downloadBlob(blob, fileName);
        toast.success(tCommon('table.exportCsv'), { description: fileName });
        setExporting(false);
      },
      (error: unknown) => {
        apiError.toastError(error, t('users.export.failed'));
        setExporting(false);
      },
    );
  }, [apiError, query, serverId, status, t, tCommon]);

  const confirmDeleteUsers = useCallback(() => {
    const selected = deleteUsers;
    if (selected.length === 0) return;
    userBulk.mutate(
      { ids: selected.map((user) => user.id), action: 'delete' },
      {
        onSuccess: (response) => reportBulk(response.results, 'users.toast.deleted'),
        onError: (error) => apiError.toastError(error, t('users.toast.deleteFailed')),
        onSettled: () => {
          setDeleteUsers([]);
          setRowSelection({});
          closeOverlay();
        },
      },
    );
  }, [apiError, closeOverlay, deleteUsers, reportBulk, t, userBulk]);

  const columns = useMemo<readonly ColumnDef<S3User, unknown>[]>(
    () => [
      selectionColumn<S3User>(),
      {
        id: 'user',
        header: () => t('users.column.user'),
        cell: ({ row }) => (
          <span className="flex items-center gap-2.5">
            <InitialsAvatar name={row.original.name} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-[0.8125rem] font-medium">
                {row.original.name}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {row.original.createdAt === null ? (
                  <Dash />
                ) : (
                  <>
                    {t('users.created')} <RelativeTime value={row.original.createdAt} />
                  </>
                )}
              </span>
            </span>
          </span>
        ),
      },
      {
        id: 'server',
        header: () => t('users.column.server'),
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <ProviderMark provider={row.original.provider} size="sm" />
            <span className="truncate font-mono text-xs">{row.original.serverName}</span>
          </span>
        ),
      },
      {
        id: 'status',
        header: () => t('users.column.status'),
        cell: ({ row }) => <UserStatusBadge status={row.original.status} />,
      },
      {
        id: 'policies',
        header: () => t('users.column.policies'),
        cell: ({ row }) => <ChipList values={row.original.policies} />,
      },
      {
        id: 'accessKeys',
        header: () => t('users.column.accessKeys'),
        cell: ({ row }) => (
          <span className="num text-xs">
            <Num value={row.original.accessKeyCount} />
          </span>
        ),
      },
      {
        id: 'groups',
        header: () => t('users.column.groups'),
        cell: ({ row }) => <ChipList values={row.original.groups} />,
      },
      {
        id: 'lastActivity',
        header: () => t('users.column.lastActivity'),
        cell: ({ row }) =>
          row.original.lastActivityAt === null ? (
            <Dash />
          ) : (
            <RelativeTime
              value={row.original.lastActivityAt}
              className="text-xs text-muted-foreground"
            />
          ),
      },
      {
        id: 'actions',
        size: 56,
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">{tCommon('table.rowActions')}</span>,
        cell: ({ row }) => {
          const user = row.original;
          return (
            /*
             * The row opens the sheet on click, and Radix opens this menu on
             * *pointer down* — so stopping only the click let both happen: the
             * menu opened and the sheet immediately stole focus and closed it.
             * Both events have to stop here. Found in the browser.
             */
            <DropdownMenu>
              <span
                className="contents"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('users.actionsFor', { name: user.name })}
                  >
                    <EllipsisIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setOpenUser(user)}>
                    <SquarePenIcon />
                    {t('users.editUser')}
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link
                      to="/keys/new"
                      state={routeState({ serverId: user.serverId, userName: user.name })}
                    >
                      <KeyRoundIcon />
                      {t('keys.create.action')}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setAttachTo([user])}>
                    <ShieldCheckIcon />
                    {t('users.attachPolicy')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => copyArn(user)}>
                    <CopyIcon />
                    {t('users.copyArn')}
                  </DropdownMenuItem>
                  {user.status === 'disabled' ? (
                    <DropdownMenuItem onSelect={() => setStatusForMany([user], 'enabled')}>
                      <PlayIcon />
                      {t('users.enable')}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => setStatusForMany([user], 'disabled')}>
                      <BanIcon />
                      {t('users.disable')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleteUsers([user])}>
                    <Trash2Icon />
                    {tCommon('action.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </span>
            </DropdownMenu>
          );
        },
      },
    ],
    [copyArn, setOpenUser, setStatusForMany, t, tCommon],
  );

  const groupColumns = useMemo<readonly ColumnDef<S3Group, unknown>[]>(
    () => [
      {
        id: 'group',
        header: () => t('users.groups.column.group'),
        cell: ({ row }) => (
          <span className="flex items-center gap-2.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-md border bg-muted/50">
              <UsersIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </span>
            <span className="truncate font-mono text-[0.8125rem] font-medium">
              {row.original.name}
            </span>
          </span>
        ),
      },
      {
        id: 'server',
        header: () => t('users.column.server'),
        cell: ({ row }) => (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {row.original.serverName}
          </span>
        ),
      },
      {
        id: 'members',
        header: () => t('users.groups.column.members'),
        cell: ({ row }) => (
          <span className="num text-xs">
            <Num value={row.original.members.length} />
          </span>
        ),
      },
      {
        id: 'policies',
        header: () => t('users.column.policies'),
        cell: ({ row }) => <ChipList values={row.original.policies} />,
      },
      {
        id: 'status',
        header: () => t('users.column.status'),
        cell: ({ row }) =>
          row.original.status === 'enabled' ? (
            <Badge variant="success">{tDomain('userStatus.enabled')}</Badge>
          ) : (
            <Badge variant="outline">{tDomain('userStatus.disabled')}</Badge>
          ),
      },
      {
        id: 'actions',
        size: 56,
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">{tCommon('table.rowActions')}</span>,
        cell: ({ row }) => {
          const group = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('users.groups.actionsFor', { name: group.name })}
                >
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => openGroup(group)}>
                  <PencilIcon />
                  {t('users.groups.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openGroup(group)}>
                  <UserPlusIcon />
                  {t('users.groups.addMembers')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleteGroup(group)}>
                  <Trash2Icon />
                  {t('users.groups.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [openGroup, t, tCommon, tDomain],
  );

  return (
    <>
      <PageHeader
        title={t('users.title')}
        description={t('users.description')}
        actions={
          <>
            <Button variant="outline" onClick={exportCsv} disabled={exporting}>
              <FileDownIcon />
              {t('users.exportList')}
            </Button>
            <Button onClick={() => void navigate({ to: '/users/new', search: true })}>
              <UserPlusIcon />
              {t('users.create.action')}
            </Button>
          </>
        }
      />

      <Alert variant="info" className="mb-(--gap-lg)">
        <InfoIcon />
        <AlertTitle>{t('users.note.title')}</AlertTitle>
        <AlertDescription>{t('users.note.body')}</AlertDescription>
      </Alert>

      <Tabs value={tab} onValueChange={(next) => setSearch({ tab: next })}>
        <TabsList aria-label={t('users.tabsLabel')}>
          <TabsTrigger value="users">
            <UsersIcon />
            {t('users.tab.users')}
            {users.data === undefined ? null : (
              <span className="num ms-1.5 rounded-full bg-muted px-1.5 text-xs">
                {format.number(users.data.total)}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="groups">
            {t('users.tab.groups')}
            {groups.data === undefined ? null : (
              <span className="num ms-1.5 rounded-full bg-muted px-1.5 text-xs">
                {format.number(groups.data.total)}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="mt-(--gap)">
          <UnavailableServersAlert unavailable={users.data?.unavailable ?? []} />

          <div className="mb-(--gap) flex flex-wrap items-center gap-2">
            <InputGroup className="w-full sm:w-64">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={(event) => setSearch({ q: event.target.value })}
                placeholder={t('users.searchPlaceholder')}
                aria-label={t('users.searchPlaceholder')}
              />
            </InputGroup>
            <Combobox
              options={serverOptions}
              value={serverId}
              onValueChange={(next) => setSearch({ serverId: next ?? undefined })}
              placeholder={t('users.allServers')}
              clearable
              className="w-full sm:w-52"
              aria-label={t('users.serverFilter')}
            />
            <Combobox
              options={statusOptions}
              value={status}
              onValueChange={(next) => setSearch({ status: next ?? undefined })}
              placeholder={t('users.allStatuses')}
              clearable
              className="w-full sm:w-44"
              aria-label={t('users.statusFilter')}
            />
            <Button
              variant="ghost"
              size="sm"
              className="sm:ms-auto"
              onClick={resetFilters}
              disabled={!hasFilters}
            >
              <RotateCcwIcon />
              {t('users.resetFilters')}
            </Button>
          </div>

          <SectionCard flush>
            {users.isError ? (
              <EmptyState
                icon={UsersIcon}
                title={tCommon('state.error')}
                description={apiError.message(users.error)}
              />
            ) : (
              <DataTable
                aria-label={t('users.title')}
                columns={columns}
                data={items}
                getRowId={(user) => `${user.serverId}/${user.name}`}
                loading={users.isLoading}
                pagination={pagination}
                onPaginationChange={setPagination}
                total={users.data?.total}
                rowSelection={rowSelection}
                onRowSelectionChange={setRowSelection}
                showColumnsMenu
                onRowClick={(user) => setOpenUser(user)}
                activeRowId={
                  openUser === null ? undefined : `${openUser.serverId}/${openUser.name}`
                }
                bulkActions={({ selectedRows }) => (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setStatusForMany(selectedRows, 'disabled')}
                      disabled={userBulk.isPending}
                    >
                      <BanIcon />
                      {t('users.disable')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setStatusForMany(selectedRows, 'enabled')}
                      disabled={userBulk.isPending}
                    >
                      <PlayIcon />
                      {t('users.enable')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setAttachTo(selectedRows)}>
                      <ShieldCheckIcon />
                      {t('users.attachPolicy')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteUsers(selectedRows)}
                    >
                      <Trash2Icon />
                      {tCommon('action.delete')}
                    </Button>
                  </>
                )}
                emptyState={
                  <EmptyState
                    icon={UsersIcon}
                    title={hasFilters ? tCommon('state.noResults') : t('users.empty.title')}
                    description={t('users.empty.description')}
                    action={
                      hasFilters ? (
                        <Button variant="outline" onClick={resetFilters}>
                          {t('users.resetFilters')}
                        </Button>
                      ) : (
                        <Button onClick={() => void navigate({ to: '/users/new', search: true })}>
                          <UserPlusIcon />
                          {t('users.create.action')}
                        </Button>
                      )
                    }
                  />
                }
              />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="groups" className="mt-(--gap)">
          <UnavailableServersAlert unavailable={groups.data?.unavailable ?? []} />

          <div className="mb-(--gap) flex flex-wrap items-center gap-2">
            <InputGroup className="w-full sm:w-64">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                value={groupQuery}
                onChange={(event) => setSearch({ gq: event.target.value })}
                placeholder={t('users.groups.searchPlaceholder')}
                aria-label={t('users.groups.searchPlaceholder')}
              />
            </InputGroup>
            <Combobox
              options={serverOptions}
              value={serverId}
              onValueChange={(next) => setSearch({ serverId: next ?? undefined })}
              placeholder={t('users.allServers')}
              clearable
              className="w-full sm:w-52"
              aria-label={t('users.serverFilter')}
            />
            <Button
              variant="outline"
              className="sm:ms-auto"
              onClick={() => void navigate({ to: '/users/groups/new', search: true })}
            >
              <PlusIcon />
              {t('users.groups.create')}
            </Button>
          </div>

          <SectionCard
            flush
            footer={
              <span className="text-xs text-muted-foreground">{t('users.groups.scopeNote')}</span>
            }
          >
            <DataTable
              aria-label={t('users.tab.groups')}
              columns={groupColumns}
              data={groupItems}
              getRowId={(group) => `${group.serverId}/${group.name}`}
              loading={groups.isLoading}
              emptyState={
                <EmptyState
                  icon={UsersIcon}
                  title={t('users.groups.empty.title')}
                  description={t('users.groups.empty.description')}
                  action={
                    <Button onClick={() => void navigate({ to: '/users/groups/new', search: true })}>
                      <PlusIcon />
                      {t('users.groups.create')}
                    </Button>
                  }
                />
              }
            />
          </SectionCard>
        </TabsContent>
      </Tabs>

      {/* `/users/new` and `/users/groups/new` render here. */}
      <Outlet />

      {openUser === null ? null : (
        <UserSheet
          user={openUser}
          onClose={closeOverlay}
          onDelete={(user) => setDeleteUsers([user])}
        />
      )}

      {openGroupEntity === null ? null : (
        <CreateS3GroupDialog
          existingGroup={openGroupEntity}
          initialServerId={null}
          onClose={closeOverlay}
        />
      )}

      <AttachPolicyDialog
        users={attachTo}
        policyOptions={(policies.data?.items ?? []).map((policy) => ({
          value: policy.name,
          label: policy.name,
          description: policy.description ?? undefined,
        }))}
        busy={userBulk.isPending}
        onClose={() => setAttachTo([])}
        onAttach={(policyName) => {
          if (attachTo.length === 0) return;
          // One request: the API attaches the policy to every named user and
          // reports a row each. Attaching is idempotent server-side, so the
          // "already has it" case needs no client-side filtering.
          userBulk.mutate(
            {
              ids: attachTo.map((user) => user.id),
              action: 'attach-policy',
              payload: { policy: policyName },
            },
            {
              onSuccess: (response) => reportBulk(response.results, 'users.toast.policyAttached'),
              onError: (error) => apiError.toastError(error, t('users.toast.policyFailed')),
              onSettled: () => {
                setAttachTo([]);
                setRowSelection({});
              },
            },
          );
        }}
      />

      <ConfirmDialog
        open={deleteUsers.length > 0}
        onOpenChange={(open) => {
          if (!open) setDeleteUsers([]);
        }}
        title={t('users.delete.title', { count: deleteUsers.length })}
        description={t('users.delete.description')}
        confirmLabel={tCommon('action.delete')}
        destructive
        busy={userBulk.isPending}
        onConfirm={confirmDeleteUsers}
      >
        <Alert variant="danger">
          <AlertDescription>{t('users.delete.warning')}</AlertDescription>
        </Alert>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteGroup !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteGroup(null);
        }}
        title={t('users.groups.deleteTitle')}
        description={t('users.groups.deleteDescription')}
        confirmLabel={tCommon('action.delete')}
        destructive
        busy={removeGroup.isPending}
        onConfirm={() => {
          const group = deleteGroup;
          if (group === null) return;
          removeGroup.mutate(
            { serverId: group.serverId, name: group.name },
            {
              onSuccess: () => {
                toast.success(t('users.toast.groupDeleted'), { description: group.name });
                setDeleteGroup(null);
              },
              onError: (error) => apiError.toastError(error, t('users.toast.groupSaveFailed')),
            },
          );
        }}
      />
    </>
  );
}

const CHIP_LIMIT = 1;

/** The concept's `.chips` cell: one name, then "+N" with the rest in the title. */
function ChipList({ values }: { readonly values: readonly string[] }) {
  if (values.length === 0) return <Dash />;
  const shown = values.slice(0, CHIP_LIMIT);
  const rest = values.slice(CHIP_LIMIT);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((value) => (
        <Badge key={value} variant="outline" className="font-mono">
          {value}
        </Badge>
      ))}
      {rest.length === 0 ? null : (
        <Badge variant="secondary" title={rest.join(', ')}>
          +<Num value={rest.length} />
        </Badge>
      )}
    </span>
  );
}

function AttachPolicyDialog({
  users,
  policyOptions,
  busy,
  onClose,
  onAttach,
}: {
  readonly users: readonly S3User[];
  readonly policyOptions: readonly ComboboxOption<string>[];
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onAttach: (policyName: string) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <Dialog
      open={users.length > 0}
      onOpenChange={(open) => {
        if (!open) {
          setPicked(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('users.attachPolicy')}</DialogTitle>
          <DialogDescription>
            {t('users.attach.description', { count: users.length })}
          </DialogDescription>
        </DialogHeader>

        <FormField label={t('users.attach.policy')}>
          {({ id }) => (
            <Combobox
              id={id}
              options={policyOptions}
              value={picked}
              onValueChange={setPicked}
              placeholder={t('users.sheet.selectPolicy')}
              aria-label={t('users.attach.policy')}
            />
          )}
        </FormField>

        <Alert variant="info">
          <InfoIcon />
          <AlertDescription>{t('users.attach.note')}</AlertDescription>
        </Alert>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (picked !== null) onAttach(picked);
            }}
            disabled={picked === null || busy}
          >
            {busy ? <Spinner /> : <ShieldCheckIcon />}
            {t('users.sheet.attach')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
