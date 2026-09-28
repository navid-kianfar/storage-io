import type { S3User, Server } from '@storage-io/contracts';
import { Link } from '@tanstack/react-router';
import { routeState } from '@/lib/dialogs/route';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import {
  ArrowRightIcon,
  InfoIcon,
  KeyRoundIcon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  DataTable,
  Dash,
  EmptyState,
  InitialsAvatar,
  Num,
  RelativeTime,
  SectionCard,
  UserStatusBadge,
} from '@/components/app';
import { useServerIamUsers } from '@/features/servers/api';
import { isApiError } from '@/lib/api/errors';
import { useApiError } from '@/lib/api/useApiError';

const USERS_PAGE_SIZE = 10;

/**
 * S3 users on this server. A provider whose IAM driver is `none` (R2, generic S3)
 * has no users to show, and the API answers `NOT_SUPPORTED` — that is a state with
 * its own copy here, not an empty table.
 *
 * "New S3 user" opens the `create-s3-user` dialog, which `/users` owns: opening it
 * navigates there with this server pre-selected, so there is exactly one create-user
 * form in the app.
 */
export function ServerUsersTab({ server }: { readonly server: Server }) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const supported = server.capabilities.iamUsers === 'supported';
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: USERS_PAGE_SIZE,
  });

  const users = useServerIamUsers(server.id, {
    page: pagination.pageIndex + 1,
    pageSize: pagination.pageSize,
    enabled: supported,
  });

  const columns = useMemo<readonly ColumnDef<S3User, unknown>[]>(
    () => [
      {
        id: 'name',
        header: () => t('server.users.user'),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <InitialsAvatar name={row.original.name} />
            <span className="truncate font-mono text-[0.8125rem] font-medium">
              {row.original.name}
            </span>
          </div>
        ),
      },
      {
        id: 'policies',
        header: () => t('server.users.policies'),
        cell: ({ row }) => {
          const policies = row.original.policies;
          if (policies.length === 0) return <Dash />;
          return (
            <div className="flex flex-wrap gap-1">
              {policies.map((policy) => (
                <Badge key={policy} variant="outline" className="font-mono">
                  {policy}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        id: 'keys',
        header: () => t('server.users.accessKeys'),
        cell: ({ row }) => <Num value={row.original.accessKeyCount} />,
      },
      {
        id: 'status',
        header: () => t('server.users.status'),
        cell: ({ row }) => <UserStatusBadge status={row.original.status} />,
      },
      {
        id: 'lastActivity',
        header: () => t('server.users.lastUsed'),
        cell: ({ row }) =>
          row.original.lastActivityAt === null ? (
            <Dash />
          ) : (
            <RelativeTime
              value={row.original.lastActivityAt}
              className="text-muted-foreground"
            />
          ),
      },
      {
        id: 'open',
        size: 48,
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">{tCommon('table.rowActions')}</span>,
        cell: ({ row }) => (
          <Button variant="ghost" size="icon-sm" asChild aria-label={t('server.users.openUser')}>
            {/* The user's own route: the list used to be filtered down to a name,
                which is a search for one row rather than a link to it. */}
            <Link to="/users/$userId" params={{ userId: row.original.id }}>
              <ArrowRightIcon className="flip-rtl" />
            </Link>
          </Button>
        ),
      },
    ],
    [server.id, t, tCommon],
  );

  const notSupported =
    !supported || (users.isError && isApiError(users.error) && users.error.is('NOT_SUPPORTED'));

  return (
    <div className="flex flex-col gap-(--gap)">
      <SectionCard
        title={t('server.users.title')}
        description={t('server.users.description')}
        action={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to="/users" search={{ serverId: server.id }}>
                <UsersIcon />
                {t('server.users.manageUsers')}
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/keys" search={{ serverId: server.id }}>
                <KeyRoundIcon />
                {t('server.users.manageKeys')}
              </Link>
            </Button>
            <Button size="sm" disabled={notSupported} asChild>
              <Link to="/users/new" state={routeState({ serverId: server.id })}>
                <UserPlusIcon />
                {t('server.users.newUser')}
              </Link>
            </Button>
          </>
        }
        flush
      >
        {notSupported ? (
          <EmptyState
            icon={UsersIcon}
            title={tCommon('state.notSupported')}
            description={t('server.users.unsupported')}
          />
        ) : users.isError ? (
          <EmptyState
            icon={UsersIcon}
            title={tCommon('state.error')}
            description={apiError.message(users.error)}
          />
        ) : (
          <DataTable
            aria-label={t('server.users.title')}
            columns={columns}
            data={users.data?.items ?? []}
            getRowId={(user) => `${user.serverId}/${user.name}`}
            loading={users.isLoading}
            pagination={pagination}
            onPaginationChange={setPagination}
            total={users.data?.total}
            emptyState={
              <EmptyState
                icon={UsersIcon}
                title={t('server.users.emptyTitle')}
                description={t('server.users.emptyDescription')}
                action={
                  <Button asChild>
                    <Link to="/users/new" state={routeState({ serverId: server.id })}>
                      <UserPlusIcon />
                      {t('server.users.newUser')}
                    </Link>
                  </Button>
                }
              />
            }
          />
        )}
      </SectionCard>

      <Alert variant="info">
        <InfoIcon />
        <AlertTitle>{t('server.users.secretNoteTitle')}</AlertTitle>
        <AlertDescription>{t('server.users.secretNoteBody')}</AlertDescription>
      </Alert>
    </div>
  );
}
