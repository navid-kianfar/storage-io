import {
  PROVIDER_LABELS,
  PROVIDERS,
  type ListServersQuery,
  type Provider,
  type Server,
} from '@storage-io/contracts';
import { Outlet, useNavigate, useSearch } from '@tanstack/react-router';
import { PlusIcon, RefreshCwIcon, SearchIcon, ServerIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Bytes,
  Button,
  Combobox,
  ConfirmDialog,
  EmptyState,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  PageHeader,
  SegmentedControl,
  Skeleton,
  Spinner,
  type ComboboxOption,
  type SegmentedOption,
} from '@/components/app';
import {
  AddServerCard,
  ServerCard,
  type ServerCardActions,
} from '@/features/servers/components/ServerCard';
import {
  useCheckAllServers,
  useCheckServer,
  useDeleteServer,
  useServers,
  useSetMaintenance,
  useTestServer,
} from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';


/**
 * Every endpoint storage-io manages, as cards rather than rows: a server's health,
 * capacity and the four numbers an operator checks are not a table's worth of
 * columns, and the degraded and offline states need room for their own text.
 *
 * The filters live in the URL, so a filtered view is a link. `q` and `provider` go
 * to the API; the health tab is applied here, because "needs attention" is two of
 * the contract's statuses and `?status=` takes one.
 */

type HealthTab = 'all' | 'healthy' | 'attention';

const HEALTH_TABS: readonly HealthTab[] = ['all', 'healthy', 'attention'];

/** What this page keeps in the URL. Everything is optional: a bare /servers is valid. */
interface ServersSearch {
  readonly q?: string;
  readonly provider?: string;
  readonly health?: string;
}

function isHealthTab(value: unknown): value is HealthTab {
  return typeof value === 'string' && (HEALTH_TABS as readonly string[]).includes(value);
}

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

function matchesTab(server: Server, tab: HealthTab): boolean {
  switch (tab) {
    case 'all':
      return true;
    case 'healthy':
      return server.status === 'healthy';
    case 'attention':
      return server.status === 'degraded' || server.status === 'offline';
  }
}

export function ServersPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const apiError = useApiError();

  const search = useSearch({ strict: false });
  const query = typeof search.q === 'string' ? search.q : '';
  const tab: HealthTab = isHealthTab(search.health) ? search.health : 'all';
  const provider: Provider | null = isProvider(search.provider) ? search.provider : null;

  const setSearch = useCallback(
    (next: Partial<ServersSearch>) => {
      void navigate({
        to: '/servers',
        search: (current: Record<string, unknown>) => ({ ...current, ...next }),
        replace: true,
      });
    },
    [navigate],
  );

  // An empty filter object is passed as `undefined` so the key matches the shell's
  // own unfiltered server query instead of fetching the same list twice.
  const filters = useMemo<ListServersQuery | undefined>(() => {
    const next: ListServersQuery = {
      ...(query.length > 0 ? { q: query } : {}),
      ...(provider === null ? {} : { provider }),
    };
    return Object.keys(next).length === 0 ? undefined : next;
  }, [provider, query]);
  const servers = useServers(filters);

  const testServer = useTestServer();
  const checkServer = useCheckServer();
  const checkAll = useCheckAllServers();
  const setMaintenance = useSetMaintenance();
  const deleteServer = useDeleteServer();

  const [pendingRemoval, setPendingRemoval] = useState<Server | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const items = useMemo(() => servers.data?.items ?? [], [servers.data]);
  const visible = useMemo(() => items.filter((server) => matchesTab(server, tab)), [items, tab]);

  const healthyCount = items.filter((server) => server.status === 'healthy').length;
  const attentionCount = items.filter(
    (server) => server.status === 'degraded' || server.status === 'offline',
  ).length;

  const usedBytes = items.reduce((sum, server) => sum + (server.capacity.usedBytes ?? 0), 0);
  const totalBytes = items.reduce((sum, server) => sum + (server.capacity.totalBytes ?? 0), 0);

  const tabs = useMemo<readonly SegmentedOption<HealthTab>[]>(
    () => [
      { value: 'all', label: t('servers.tab.all'), count: items.length },
      { value: 'healthy', label: t('servers.tab.healthy'), count: healthyCount },
      { value: 'attention', label: t('servers.tab.attention'), count: attentionCount },
    ],
    [attentionCount, healthyCount, items.length, t],
  );

  const providerOptions = useMemo<readonly ComboboxOption<Provider>[]>(
    () => PROVIDERS.map((name) => ({ value: name, label: PROVIDER_LABELS[name] })),
    [],
  );

  const runTest = useCallback(
    (server: Server) => {
      setBusyId(server.id);
      testServer.mutate(server.id, {
        onSuccess: (response) => {
          const failed = response.checks.filter((check) => check.status === 'fail');
          if (failed.length > 0) {
            toast.error(t('servers.toast.testFailed'), {
              description: failed[0]?.detail ?? failed[0]?.label,
            });
            return;
          }
          const slowest = response.checks.reduce(
            (max, check) => Math.max(max, check.durationMs),
            0,
          );
          toast.success(t('servers.toast.testOk'), {
            description: t('servers.toast.testOkDetail', { name: server.name, ms: slowest }),
          });
        },
        onError: (error) => apiError.toastError(error, t('servers.toast.testFailed')),
        onSettled: () => setBusyId(null),
      });
    },
    [apiError, t, testServer],
  );

  const runCheck = useCallback(
    (server: Server) => {
      setBusyId(server.id);
      checkServer.mutate(server.id, {
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
        onSettled: () => setBusyId(null),
      });
    },
    [apiError, checkServer, t],
  );

  const toggleMaintenance = useCallback(
    (server: Server) => {
      setBusyId(server.id);
      setMaintenance.mutate(
        { serverId: server.id, enabled: !server.maintenance },
        {
          onSuccess: (updated) => {
            toast.success(
              updated.maintenance
                ? t('servers.toast.maintenanceOn')
                : t('servers.toast.maintenanceOff'),
              { description: updated.name },
            );
          },
          onError: (error) => apiError.toastError(error),
          onSettled: () => setBusyId(null),
        },
      );
    },
    [apiError, setMaintenance, t],
  );

  const actions = useMemo<ServerCardActions>(
    () => ({
      onTest: runTest,
      onCheck: runCheck,
      // Editing and rotating belong to the server, so they are that server's own
      // routes; the list is where they are reached from, not where they live.
      onEdit: (server) =>
        void navigate({ to: '/servers/$serverId/edit', params: { serverId: server.id } }),
      onRotate: (server) =>
        void navigate({
          to: '/servers/$serverId/rotate-credentials',
          params: { serverId: server.id },
        }),
      onToggleMaintenance: toggleMaintenance,
      onRemove: setPendingRemoval,
    }),
    [navigate, runCheck, runTest, toggleMaintenance],
  );

  const confirmRemoval = useCallback(() => {
    if (pendingRemoval === null) return;
    const name = pendingRemoval.name;
    deleteServer.mutate(pendingRemoval.id, {
      onSuccess: () => {
        toast.success(t('servers.toast.removed'), { description: name });
        setPendingRemoval(null);
      },
      onError: (error) => apiError.toastError(error, t('servers.toast.removeFailed')),
    });
  }, [apiError, deleteServer, pendingRemoval, t]);

  return (
    <>
      <PageHeader
        title={t('servers.title')}
        description={t('servers.description')}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() =>
                checkAll.mutate(undefined, {
                  onSuccess: () => toast.info(t('servers.toast.checkingAll')),
                  onError: (error) => apiError.toastError(error),
                })
              }
              disabled={checkAll.isPending}
            >
              {checkAll.isPending ? <Spinner /> : <RefreshCwIcon />}
              {t('servers.checkAll')}
            </Button>
            <Button onClick={() => void navigate({ to: '/servers/new' })}>
              <PlusIcon />
              {t('servers.add')}
            </Button>
          </>
        }
      />

      <div className="mb-(--gap) flex flex-wrap items-center gap-2">
        <InputGroup className="w-full sm:w-64">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setSearch({ q: event.target.value })}
            placeholder={t('servers.searchPlaceholder')}
            aria-label={t('servers.searchPlaceholder')}
          />
        </InputGroup>

        <SegmentedControl
          options={tabs}
          value={tab}
          onValueChange={(next) => setSearch({ health: next })}
          aria-label={t('servers.tab.label')}
        />

        <Combobox
          options={providerOptions}
          value={provider}
          onValueChange={(next) => setSearch({ provider: next ?? undefined })}
          placeholder={t('servers.allProviders')}
          clearable
          className="w-full sm:w-44"
          aria-label={t('servers.providerFilter')}
        />

        <span className="ms-auto text-[0.8125rem] text-muted-foreground">
          <Bytes value={usedBytes} />
          {totalBytes > 0 ? (
            <>
              {' / '}
              <Bytes value={totalBytes} />
            </>
          ) : null}{' '}
          {t('servers.usedAcross')}
        </span>
      </div>

      {servers.isLoading ? (
        <div className="grid gap-(--gap) lg:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_unused, index) => (
            <Skeleton key={index} className="h-72 rounded-xl" />
          ))}
        </div>
      ) : servers.isError ? (
        <EmptyState
          icon={ServerIcon}
          title={tCommon('state.error')}
          description={apiError.message(servers.error)}
          action={
            <Button variant="outline" onClick={() => void servers.refetch()}>
              <RefreshCwIcon />
              {tCommon('action.retry')}
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={ServerIcon}
          title={items.length === 0 ? t('servers.empty.title') : tCommon('state.noResults')}
          description={
            items.length === 0 ? t('servers.empty.description') : t('servers.empty.filtered')
          }
          action={
            items.length === 0 ? (
              <Button onClick={() => void navigate({ to: '/servers/new' })}>
                <PlusIcon />
                {t('servers.add')}
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => setSearch({ q: undefined, provider: undefined, health: 'all' })}
              >
                {tCommon('action.clear')}
              </Button>
            )
          }
        />
      ) : (
        <div className="grid gap-(--gap) lg:grid-cols-2 xl:grid-cols-3">
          {visible.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              actions={actions}
              testing={busyId === server.id && testServer.isPending}
              checking={busyId === server.id && checkServer.isPending}
              maintenanceBusy={busyId === server.id && setMaintenance.isPending}
            />
          ))}
          <AddServerCard onClick={() => void navigate({ to: '/servers/new' })} />
        </div>
      )}

      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        destructive
        title={t('servers.remove.title')}
        description={t('servers.remove.description')}
        confirmValue={pendingRemoval?.name}
        confirmValueLabel={t('servers.remove.confirmLabel')}
        confirmLabel={t('servers.card.remove')}
        busy={deleteServer.isPending}
        onConfirm={confirmRemoval}
      />

      {/* `/servers/new` renders here. */}
      <Outlet />
    </>
  );
}
