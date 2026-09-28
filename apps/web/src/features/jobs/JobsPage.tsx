import {
  JOB_TERMINAL_STATUSES,
  JOB_TYPES,
  JOB_VIEWS,
  type Job,
  type JobStatus,
  type JobType,
  type JobView,
} from '@storage-io/contracts';
import { Link, Outlet, useNavigate, useSearch } from '@tanstack/react-router';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import {
  BanIcon,
  CalendarClockIcon,
  CopyIcon,
  CopyPlusIcon,
  EllipsisIcon,
  FileDownIcon,
  FileJsonIcon,
  HistoryIcon,
  LayersIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  SettingsIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Bytes,
  Button,
  Combobox,
  ConfirmDialog,
  DataTable,
  Dash,
  DateTime,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  JobStatusBadge,
  Num,
  PageHeader,
  RelativeTime,
  SectionCard,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type ComboboxOption,
} from '@/components/app';
import {
  useDeleteJob,
  useDuplicateJob,
  useJob,
  useJobCommand,
  useJobs,
  useUpdateJob,
  type JobCommand,
} from '@/features/jobs/api';
import { ActiveJobCard } from '@/features/jobs/components/ActiveJobCard';
import { ConcurrencyDialog } from '@/features/jobs/components/ConcurrencyDialog';
import { CronText } from '@/features/jobs/components/CronText';
import { EditScheduleDialog } from '@/features/jobs/components/EditScheduleDialog';
import { JobLogSheet } from '@/features/jobs/components/JobLogSheet';
import { RunDuration, RunHistorySheet } from '@/features/jobs/components/RunHistorySheet';
import { JOB_TYPE_ICONS, jobSourcePath, jobTargetPath } from '@/features/jobs/jobTypes';
import { useApiError } from '@/lib/api/useApiError';
import { useRouteOverlay } from '@/lib/dialogs/route';
import { csvFileName, downloadCsv, toCsv } from '@/lib/csv/csv';
import { useFormat } from '@/lib/format/FormatProvider';


/**
 * Bulk jobs: what is running now, what is scheduled, and what has already run.
 *
 * The three views are three server queries (`GET /jobs?view=…`), not one list
 * filtered in the browser — a history of 48 jobs and three running ones have
 * nothing in common but the word "job", and the counts on the tabs come from the
 * same response so they cannot disagree with the rows underneath.
 *
 * Nothing here polls. `job.progress` and `job.status` arrive on the SSE stream and
 * invalidate the jobs scope, which is what moves a progress bar and what flips a
 * card out of Active the moment the server finishes it.
 */

const HISTORY_PAGE_SIZE = 10;

/** The results a finished job can carry, for the History "Any result" filter. */
const HISTORY_STATUSES: readonly JobStatus[] = JOB_TERMINAL_STATUSES;

function isJobView(value: unknown): value is JobView {
  return typeof value === 'string' && (JOB_VIEWS as readonly string[]).includes(value);
}

export function JobsPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomainRoot } = useTranslation('domain');
  const navigate = useNavigate();
  const apiError = useApiError();
  const format = useFormat();

  const search = useSearch({ strict: false });
  const view: JobView = isJobView(search.view) ? search.view : 'active';

  const [cancelJob, setCancelJob] = useState<Job | null>(null);
  const [concurrencyJob, setConcurrencyJob] = useState<Job | null>(null);
  const [scheduleJob, setScheduleJob] = useState<Job | null>(null);

  /**
   * The log sheet and the run history are routes — `/jobs/$jobId` and
   * `/jobs/$jobId/runs` — so a link to a running job is a link an operator can
   * send. They act on the row behind them (pause, resume, cancel), so this page
   * keeps ownership and the route only says which overlay and which id.
   */
  const overlay = useRouteOverlay();
  const overlayJob = useJob(overlay.params.jobId ?? null);
  const logJob = overlay.name === 'job-log' ? (overlayJob.data ?? null) : null;
  const runsJob = overlay.name === 'job-runs' ? (overlayJob.data ?? null) : null;

  const closeOverlay = useCallback(() => {
    void navigate({ to: '/jobs', search: true });
  }, [navigate]);

  const setLogJob = useCallback(
    (job: Job) => {
      void navigate({ to: '/jobs/$jobId', params: { jobId: job.id }, search: true });
    },
    [navigate],
  );

  const setRunsJob = useCallback(
    (job: Job) => {
      void navigate({ to: '/jobs/$jobId/runs', params: { jobId: job.id }, search: true });
    },
    [navigate],
  );
  const [deleteScheduleJob, setDeleteScheduleJob] = useState<Job | null>(null);
  const [deleteHistoryJob, setDeleteHistoryJob] = useState<Job | null>(null);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: HISTORY_PAGE_SIZE,
  });
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyType, setHistoryType] = useState<JobType | null>(null);
  const [historyResult, setHistoryResult] = useState<JobStatus | null>(null);

  const jobs = useJobs(view);
  const command = useJobCommand();
  const updateJob = useUpdateJob();
  const duplicateJob = useDuplicateJob();
  const deleteJob = useDeleteJob();

  const items = useMemo(() => jobs.data?.items ?? [], [jobs.data]);
  const counts = jobs.data?.counts;

  const setView = useCallback(
    (next: JobView) => {
      setPagination((state) => ({ ...state, pageIndex: 0 }));
      void navigate({
        to: '/jobs',
        search: (current: Record<string, unknown>) => ({ ...current, view: next }),
        replace: true,
      });
    },
    [navigate],
  );

  const runCommand = useCallback(
    (job: Job, nextCommand: JobCommand, successKey: string) => {
      command.mutate(
        { jobId: job.id, command: nextCommand },
        {
          onSuccess: () => toast.success(t(successKey), { description: job.name }),
          onError: (error) => apiError.toastError(error, t('jobs.toast.commandFailed')),
        },
      );
    },
    [apiError, command, t],
  );

  const pause = useCallback(
    (job: Job) => runCommand(job, 'pause', 'jobs.toast.paused'),
    [runCommand],
  );
  const resume = useCallback(
    (job: Job) => runCommand(job, 'resume', 'jobs.toast.resumed'),
    [runCommand],
  );
  const runNow = useCallback(
    (job: Job) => runCommand(job, 'run-now', 'jobs.toast.queued'),
    [runCommand],
  );

  const confirmCancel = useCallback(() => {
    const job = cancelJob;
    if (job === null) return;
    command.mutate(
      { jobId: job.id, command: 'cancel' },
      {
        onSuccess: () => {
          toast.success(t('jobs.toast.cancelled'), { description: job.name });
          setCancelJob(null);
          closeOverlay();
        },
        onError: (error) => apiError.toastError(error, t('jobs.toast.commandFailed')),
      },
    );
  }, [apiError, cancelJob, closeOverlay, command, t]);

  const toggleSchedule = useCallback(
    (job: Job, enabled: boolean) => {
      updateJob.mutate(
        { jobId: job.id, enabled },
        {
          onSuccess: () =>
            toast.success(enabled ? t('jobs.toast.enabled') : t('jobs.toast.disabled'), {
              description: job.name,
            }),
          onError: (error) => apiError.toastError(error, t('jobs.toast.scheduleSaveFailed')),
        },
      );
    },
    [apiError, t, updateJob],
  );

  const duplicate = useCallback(
    (job: Job, asSchedule: boolean) => {
      const cron = job.schedule.kind === 'cron' ? job.schedule.cron : '0 3 * * *';
      const timezone =
        job.schedule.kind === 'cron'
          ? job.schedule.timezone
          : Intl.DateTimeFormat().resolvedOptions().timeZone;
      duplicateJob.mutate(
        { jobId: job.id, ...(asSchedule ? { asSchedule: { cron, timezone } } : {}) },
        {
          onSuccess: (created) => {
            toast.success(asSchedule ? t('jobs.toast.savedAsSchedule') : t('jobs.toast.duplicated'), {
              description: created.name,
            });
            if (asSchedule) setView('scheduled');
          },
          onError: (error) => apiError.toastError(error, t('jobs.toast.duplicateFailed')),
        },
      );
    },
    [apiError, duplicateJob, setView, t],
  );

  const removeJob = useCallback(
    (job: Job, onDone: () => void) => {
      deleteJob.mutate(job.id, {
        onSuccess: () => {
          toast.success(t('jobs.toast.deleted'), { description: job.name });
          onDone();
        },
        onError: (error) => apiError.toastError(error, t('jobs.toast.deleteFailed')),
      });
    },
    [apiError, deleteJob, t],
  );

  const copyId = useCallback(
    (job: Job) => {
      void navigator.clipboard.writeText(job.id).then(
        () => toast.success(tCommon('action.copied'), { description: job.id }),
        () => toast.error(t('jobs.toast.copyFailed')),
      );
    },
    [t, tCommon],
  );

  const exportHistory = useCallback(() => {
    if (items.length === 0) {
      toast.error(t('jobs.export.nothing'));
      return;
    }
    const csv = toCsv(
      [
        t('jobs.column.job'),
        t('jobs.column.type'),
        t('jobs.column.status'),
        t('jobs.column.objects'),
        t('jobs.column.failed'),
        t('jobs.column.size'),
        t('jobs.column.started'),
        t('jobs.column.finished'),
      ],
      items.map((job) => [
        job.name,
        job.type,
        job.status,
        job.progress.processed,
        job.progress.failed,
        job.progress.bytes,
        job.startedAt,
        job.finishedAt,
      ]),
    );
    const fileName = csvFileName('jobs-history');
    downloadCsv(csv, fileName);
    toast.success(tCommon('table.exportCsv'), { description: fileName });
  }, [items, t, tCommon]);

  const pauseAll = useCallback(() => {
    const running = items.filter((job) => job.status === 'running');
    if (running.length === 0) {
      toast.error(t('jobs.noRunningJobs'));
      return;
    }
    // The contract has no bulk pause endpoint, so this is the one place a per-item
    // loop is the honest implementation: `POST /jobs/:id/pause` is per job. It is
    // bounded by what is on screen (the active view), not by an unbounded set.
    for (const job of running) pause(job);
  }, [items, pause, t]);

  /* --------------------------- scheduled table -------------------------- */

  const scheduledColumns = useMemo<readonly ColumnDef<Job, unknown>[]>(
    () => [
      {
        id: 'job',
        header: () => t('jobs.column.job'),
        cell: ({ row }) => <JobIdentity job={row.original} />,
      },
      {
        id: 'schedule',
        header: () => t('jobs.column.schedule'),
        cell: ({ row }) => {
          const schedule = row.original.schedule;
          if (schedule.kind !== 'cron') return <Dash />;
          return (
            <div className="flex flex-col">
              <span className="font-mono text-xs" dir="ltr">
                {schedule.cron}
              </span>
              <CronText cron={schedule.cron} className="text-xs text-muted-foreground" />
            </div>
          );
        },
      },
      {
        id: 'nextRun',
        header: () => t('jobs.column.nextRun'),
        cell: ({ row }) => {
          const schedule = row.original.schedule;
          if (schedule.kind !== 'cron' || schedule.nextRunAt === null) return <Dash />;
          return <RelativeTime value={schedule.nextRunAt} className="text-xs" />;
        },
      },
      {
        id: 'lastRun',
        header: () => t('jobs.column.lastRun'),
        cell: ({ row }) =>
          row.original.finishedAt === null ? (
            <Dash />
          ) : (
            <RelativeTime value={row.original.finishedAt} className="text-xs text-muted-foreground" />
          ),
      },
      {
        id: 'enabled',
        size: 90,
        enableSorting: false,
        header: () => t('jobs.column.enabled'),
        cell: ({ row }) => {
          const schedule = row.original.schedule;
          const enabled = schedule.kind === 'cron' ? schedule.enabled : false;
          return (
            <Switch
              checked={enabled}
              disabled={updateJob.isPending}
              onCheckedChange={(next) => toggleSchedule(row.original, next)}
              aria-label={t('jobs.schedule.toggleFor', { name: row.original.name })}
            />
          );
        },
      },
      {
        id: 'actions',
        size: 56,
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">{tCommon('table.rowActions')}</span>,
        cell: ({ row }) => {
          const job = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('jobs.actionsFor', { name: job.name })}
                >
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => runNow(job)}>
                  <PlayIcon />
                  {t('jobs.runNow')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setScheduleJob(job)}>
                  <PencilIcon />
                  {t('jobs.schedule.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setRunsJob(job)}>
                  <HistoryIcon />
                  {t('jobs.schedule.runHistory')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleteScheduleJob(job)}>
                  <Trash2Icon />
                  {t('jobs.schedule.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [runNow, t, tCommon, toggleSchedule, updateJob.isPending],
  );

  /* ---------------------------- history table --------------------------- */

  const historyColumns = useMemo<readonly ColumnDef<Job, unknown>[]>(
    () => [
      {
        id: 'job',
        header: () => t('jobs.column.job'),
        cell: ({ row }) => <JobIdentity job={row.original} />,
      },
      {
        id: 'status',
        header: () => t('jobs.column.status'),
        cell: ({ row }) => <JobStatusBadge status={row.original.status} />,
      },
      {
        id: 'objects',
        header: () => t('jobs.column.objects'),
        cell: ({ row }) => (
          <span className="num text-xs">
            <Num value={row.original.progress.processed} compact />
            {row.original.progress.failed === 0 ? null : (
              <span className="text-destructive">
                {' '}
                (<Num value={row.original.progress.failed} />)
              </span>
            )}
          </span>
        ),
      },
      {
        id: 'size',
        header: () => t('jobs.column.size'),
        cell: ({ row }) => (
          <span className="num text-xs">
            <Bytes value={row.original.progress.bytes} />
          </span>
        ),
      },
      {
        id: 'duration',
        header: () => t('jobs.column.duration'),
        cell: ({ row }) => (
          <span className="num text-xs">
            <RunDuration
              startedAt={row.original.startedAt}
              finishedAt={row.original.finishedAt}
            />
          </span>
        ),
      },
      {
        id: 'finished',
        header: () => t('jobs.column.finished'),
        cell: ({ row }) =>
          row.original.finishedAt === null ? (
            <Dash />
          ) : (
            <span className="text-xs text-muted-foreground">
              <DateTime value={row.original.finishedAt} />
            </span>
          ),
      },
      {
        id: 'actions',
        size: 56,
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">{tCommon('table.rowActions')}</span>,
        cell: ({ row }) => {
          const job = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('jobs.actionsFor', { name: job.name })}
                >
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setLogJob(job)}>
                  <FileJsonIcon />
                  {t('jobs.viewLog')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => duplicate(job, false)}>
                  <RotateCwIcon />
                  {t('jobs.runAgain')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => duplicate(job, true)}>
                  <CopyPlusIcon />
                  {t('jobs.duplicateAsSchedule')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => copyId(job)}>
                  <CopyIcon />
                  {t('jobs.copyId')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleteHistoryJob(job)}>
                  <Trash2Icon />
                  {t('jobs.deleteRecord')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [copyId, duplicate, t, tCommon],
  );

  const waiting = useMemo(() => items.filter((job) => job.waitingFor !== null), [items]);

  /**
   * History's search, operation and result filters run in the browser. That is not
   * a shortcut: `GET /jobs` takes `view` and nothing else (docs/API.md), so there
   * is no query to send — and the same response is what the pager pages through.
   */
  const filteredHistory = useMemo(() => {
    const needle = historyQuery.trim().toLowerCase();
    return items
      .filter((job) => historyType === null || job.type === historyType)
      .filter((job) => historyResult === null || job.status === historyResult)
      .filter(
        (job) =>
          needle.length === 0 ||
          job.name.toLowerCase().includes(needle) ||
          job.id.toLowerCase().includes(needle) ||
          job.source.bucket.toLowerCase().includes(needle),
      );
  }, [historyQuery, historyResult, historyType, items]);

  const pagedHistory = useMemo(() => {
    const start = pagination.pageIndex * pagination.pageSize;
    return filteredHistory.slice(start, start + pagination.pageSize);
  }, [filteredHistory, pagination]);

  const historyTypeOptions = useMemo<readonly ComboboxOption<JobType>[]>(
    () => JOB_TYPES.map((type) => ({ value: type, label: tDomainRoot(`jobType.${type}`) })),
    [tDomainRoot],
  );

  const historyResultOptions = useMemo<readonly ComboboxOption<JobStatus>[]>(
    () =>
      HISTORY_STATUSES.map((status) => ({
        value: status,
        label: tDomainRoot(`jobStatus.${status}`),
      })),
    [tDomainRoot],
  );

  const tabCounts: Readonly<Record<JobView, number | undefined>> = {
    active: counts?.active,
    scheduled: counts?.scheduled,
    history: counts?.history,
  };

  return (
    <>
      <PageHeader
        title={t('jobs.title')}
        description={t('jobs.description')}
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <EllipsisIcon />
                  {t('jobs.more')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={pauseAll} disabled={view !== 'active'}>
                  <PauseIcon />
                  {t('jobs.pauseAll')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={exportHistory}>
                  <FileDownIcon />
                  {t('jobs.exportHistory')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/settings/$section" params={{ section: 'transfers' }}>
                    <SettingsIcon />
                    {t('jobs.jobDefaults')}
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => void navigate({ to: '/jobs/new' })}>
              <PlusIcon />
              {t('jobs.newJob')}
            </Button>
          </>
        }
      />

      <Tabs value={view} onValueChange={(next) => setView(next as JobView)}>
        <TabsList aria-label={t('jobs.title')}>
          {JOB_VIEWS.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`jobs.tab.${value}`)}
              {tabCounts[value] === undefined ? null : (
                <span className="num ms-1.5 rounded-full bg-muted px-1.5 text-xs">
                  {format.number(tabCounts[value] ?? 0)}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="active" className="mt-(--gap) flex flex-col gap-(--gap)">
          {waiting.length > 0 ? (
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>{t('jobs.waitingAlert.title', { count: waiting.length })}</AlertTitle>
              <AlertDescription className="block text-xs">
                {waiting.map((job) => (
                  <span key={job.id} className="me-2">
                    {job.name} · <span className="font-mono">{job.waitingFor}</span>
                  </span>
                ))}
              </AlertDescription>
              <div className="col-start-2 mt-2 sm:absolute sm:end-4 sm:top-1/2 sm:col-start-auto sm:mt-0 sm:-translate-y-1/2">
                <Button variant="outline" size="sm" asChild>
                  <Link to="/servers">{t('jobs.serverHealth')}</Link>
                </Button>
              </div>
            </Alert>
          ) : null}

          {jobs.isError ? (
            <EmptyState
              icon={LayersIcon}
              title={tCommon('state.error')}
              description={apiError.message(jobs.error)}
            />
          ) : jobs.isLoading ? (
            <>
              <Skeleton className="h-52 rounded-xl" />
              <Skeleton className="h-52 rounded-xl" />
            </>
          ) : items.length === 0 ? (
            <SectionCard>
              <EmptyState
                icon={LayersIcon}
                title={t('jobs.empty.activeTitle')}
                description={t('jobs.empty.activeDescription')}
                action={
                  <Button onClick={() => void navigate({ to: '/jobs/new' })}>
                    <PlusIcon />
                    {t('jobs.newJob')}
                  </Button>
                }
              />
            </SectionCard>
          ) : (
            items.map((job) => (
              <ActiveJobCard
                key={job.id}
                job={job}
                busy={command.isPending}
                onPause={() => pause(job)}
                onResume={() => resume(job)}
                onCancel={() => setCancelJob(job)}
                onViewLog={() => setLogJob(job)}
                onChangeConcurrency={() => setConcurrencyJob(job)}
                onSaveAsSchedule={() => duplicate(job, true)}
                onCopyId={() => copyId(job)}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="scheduled" className="mt-(--gap)">
          <SectionCard
            title={t('jobs.scheduled.title')}
            description={t('jobs.scheduled.description')}
            action={
              <Button variant="outline" size="sm" onClick={() => void navigate({ to: '/jobs/new' })}>
                <CalendarClockIcon />
                {t('jobs.newSchedule')}
              </Button>
            }
            flush
          >
            <DataTable
              aria-label={t('jobs.scheduled.title')}
              columns={scheduledColumns}
              data={items}
              getRowId={(job) => job.id}
              loading={jobs.isLoading}
              emptyState={
                <EmptyState
                  icon={CalendarClockIcon}
                  title={t('jobs.empty.scheduledTitle')}
                  description={t('jobs.empty.scheduledDescription')}
                  action={
                    <Button onClick={() => void navigate({ to: '/jobs/new' })}>
                      <PlusIcon />
                      {t('jobs.newSchedule')}
                    </Button>
                  }
                />
              }
            />
          </SectionCard>
        </TabsContent>

        <TabsContent value="history" className="mt-(--gap)">
          <SectionCard
            title={t('jobs.history.title')}
            description={t('jobs.history.description')}
            action={
              <Button variant="outline" size="sm" onClick={exportHistory}>
                <FileDownIcon />
                {tCommon('table.exportCsv')}
              </Button>
            }
            flush
          >
            <DataTable
              aria-label={t('jobs.history.title')}
              columns={historyColumns}
              data={pagedHistory}
              getRowId={(job) => job.id}
              loading={jobs.isLoading}
              pagination={pagination}
              onPaginationChange={setPagination}
              total={filteredHistory.length}
              showColumnsMenu
              toolbar={
                <>
                  <InputGroup className="w-full sm:w-60">
                    <InputGroupAddon>
                      <SearchIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      value={historyQuery}
                      onChange={(event) => {
                        setHistoryQuery(event.target.value);
                        setPagination((state) => ({ ...state, pageIndex: 0 }));
                      }}
                      placeholder={t('jobs.history.searchPlaceholder')}
                      aria-label={t('jobs.history.searchPlaceholder')}
                    />
                  </InputGroup>
                  <Combobox
                    options={historyTypeOptions}
                    value={historyType}
                    onValueChange={(next) => {
                      setHistoryType(next);
                      setPagination((state) => ({ ...state, pageIndex: 0 }));
                    }}
                    placeholder={t('jobs.history.allOperations')}
                    clearable
                    className="w-full sm:w-48"
                    aria-label={t('jobs.history.allOperations')}
                  />
                  <Combobox
                    options={historyResultOptions}
                    value={historyResult}
                    onValueChange={(next) => {
                      setHistoryResult(next);
                      setPagination((state) => ({ ...state, pageIndex: 0 }));
                    }}
                    placeholder={t('jobs.history.anyResult')}
                    clearable
                    className="w-full sm:w-52"
                    aria-label={t('jobs.history.anyResult')}
                  />
                </>
              }
              emptyState={
                <EmptyState
                  icon={HistoryIcon}
                  title={t('jobs.empty.historyTitle')}
                  description={t('jobs.empty.historyDescription')}
                />
              }
            />
          </SectionCard>
        </TabsContent>
      </Tabs>

      {/* `/jobs/new` renders here; the sheets below are driven by their routes. */}
      <Outlet />

      <JobLogSheet
        job={logJob}
        onClose={closeOverlay}
        onPause={pause}
        onResume={resume}
        onCancel={setCancelJob}
      />

      {concurrencyJob === null ? null : (
        <ConcurrencyDialog job={concurrencyJob} onClose={() => setConcurrencyJob(null)} />
      )}
      {scheduleJob === null ? null : (
        <EditScheduleDialog job={scheduleJob} onClose={() => setScheduleJob(null)} />
      )}
      {runsJob === null ? null : (
        <RunHistorySheet job={runsJob} onClose={closeOverlay} />
      )}

      <ConfirmDialog
        open={cancelJob !== null}
        onOpenChange={(open) => {
          if (!open) setCancelJob(null);
        }}
        title={t('jobs.cancel.title')}
        description={t('jobs.cancel.description')}
        confirmLabel={
          <>
            <BanIcon />
            {t('jobs.cancelJob')}
          </>
        }
        cancelLabel={t('jobs.cancel.keepRunning')}
        destructive
        busy={command.isPending}
        onConfirm={confirmCancel}
      >
        {cancelJob === null ? null : (
          <dl className="grid grid-cols-[minmax(0,8rem)_1fr] gap-x-4 gap-y-1.5 text-[0.8125rem]">
            <dt className="text-muted-foreground">{t('jobs.cancel.job')}</dt>
            <dd className="min-w-0 truncate">{cancelJob.name}</dd>
            <dt className="text-muted-foreground">{t('jobs.cancel.processed')}</dt>
            <dd className="num">
              <Num value={cancelJob.progress.processed} />
              {cancelJob.progress.total === null ? null : (
                <>
                  {' / '}
                  <Num value={cancelJob.progress.total} />
                </>
              )}
            </dd>
            <dt className="text-muted-foreground">{t('jobs.cancel.transferred')}</dt>
            <dd className="num">
              <Bytes value={cancelJob.progress.bytes} />
            </dd>
          </dl>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteScheduleJob !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteScheduleJob(null);
        }}
        title={t('jobs.schedule.deleteTitle')}
        description={t('jobs.schedule.deleteDescription')}
        confirmValue={deleteScheduleJob?.name}
        confirmLabel={tCommon('action.delete')}
        destructive
        busy={deleteJob.isPending}
        onConfirm={() => {
          if (deleteScheduleJob !== null) {
            removeJob(deleteScheduleJob, () => setDeleteScheduleJob(null));
          }
        }}
      />

      <ConfirmDialog
        open={deleteHistoryJob !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteHistoryJob(null);
        }}
        title={t('jobs.history.deleteTitle')}
        description={t('jobs.history.deleteDescription')}
        confirmLabel={tCommon('action.delete')}
        destructive
        busy={deleteJob.isPending}
        onConfirm={() => {
          if (deleteHistoryJob !== null) {
            removeJob(deleteHistoryJob, () => setDeleteHistoryJob(null));
          }
        }}
      />
    </>
  );
}

/** The icon + name + path cell shared by the scheduled and history tables. */
function JobIdentity({ job }: { readonly job: Job }) {
  const { t: tDomain } = useTranslation('domain');
  const Icon = JOB_TYPE_ICONS[job.type];
  const target = jobTargetPath(job);
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-md border bg-muted/50">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[0.8125rem] font-medium">{job.name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground" dir="ltr">
          {job.source.serverName} · {jobSourcePath(job)}
          {target === null ? '' : ` → ${target}`}
        </span>
      </div>
      <span className="sr-only">{tDomain(`jobType.${job.type}`)}</span>
    </div>
  );
}
