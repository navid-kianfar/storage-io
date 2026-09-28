import {
  JOB_TERMINAL_STATUSES,
  type Job,
  type JobLogEntry,
  type JobLogLevel,
} from '@storage-io/contracts';
import { BanIcon, DownloadIcon, PauseIcon, PlayIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Dash,
  JobStatusBadge,
  Num,
  Pct,
  ScrollArea,
  SegmentedControl,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Switch,
  type SegmentedOption,
} from '@/components/app';
import { useJobLogs } from '@/features/jobs/api';
import { JOB_TYPE_ICONS, jobSourcePath, jobTargetPath } from '@/features/jobs/jobTypes';
import { useApiError } from '@/lib/api/useApiError';
import { downloadText } from '@/lib/csv/csv';
import { useFormat } from '@/lib/format/FormatProvider';
import { cn } from '@/lib/utils';

/**
 * The job log, live.
 *
 * "Live" here is the SSE stream doing its job, not a poll: the API publishes
 * `job.progress` while the job runs, `useEventStream` invalidates the whole `jobs`
 * scope, and this query is in it — so each frame the server sends brings the next
 * lines in. Follow keeps the view pinned to the bottom; turning it off lets the
 * operator read a failure without the stream yanking the scroll away, which is the
 * only reason the toggle exists.
 */

const LOG_LEVEL_FILTERS = ['all', 'error'] as const;
type LogLevelFilter = (typeof LOG_LEVEL_FILTERS)[number];

const LEVEL_CLASSES: Readonly<Record<JobLogLevel, string>> = {
  info: 'text-info-foreground',
  warn: 'text-warning-foreground',
  error: 'text-destructive-foreground',
};

export interface JobLogSheetProps {
  readonly job: Job | null;
  readonly onClose: () => void;
  readonly onPause: (job: Job) => void;
  readonly onResume: (job: Job) => void;
  readonly onCancel: (job: Job) => void;
}

export function JobLogSheet({ job, onClose, onPause, onResume, onCancel }: JobLogSheetProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const format = useFormat();

  const [level, setLevel] = useState<LogLevelFilter>('all');
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const logs = useJobLogs(job?.id ?? null, level);
  const entries = useMemo(() => logs.data?.items ?? [], [logs.data]);

  // Follow means "stay at the newest line". It runs after every render that changed
  // the entries, which is exactly when a new SSE frame has landed.
  useEffect(() => {
    if (!follow) return;
    const viewport = scrollRef.current?.querySelector('[data-slot="scroll-area-viewport"]');
    if (viewport instanceof HTMLElement) viewport.scrollTop = viewport.scrollHeight;
  }, [entries, follow]);

  const levelOptions = useMemo<readonly SegmentedOption<LogLevelFilter>[]>(
    () =>
      LOG_LEVEL_FILTERS.map((value) => ({
        value,
        label: t(`jobs.log.level.${value}`),
      })),
    [t],
  );

  const failures = useMemo(
    () => entries.filter((entry) => entry.level === 'error' && entry.key !== null),
    [entries],
  );

  if (job === null) return null;

  const Icon = JOB_TYPE_ICONS[job.type];
  const target = jobTargetPath(job);
  const finished = (JOB_TERMINAL_STATUSES as readonly string[]).includes(job.status);
  const ratio =
    job.progress.total === null || job.progress.total === 0
      ? null
      : job.progress.processed / job.progress.total;

  const downloadLog = () => {
    const text = entries
      .map(
        (entry) =>
          `${entry.at} ${entry.level.toUpperCase().padEnd(5)} ${entry.message}${
            entry.key === null ? '' : ` · ${entry.key}`
          }`,
      )
      .join('\n');
    downloadText(text, `${job.id}.log`, 'text/plain');
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-xl">
        <SheetHeader className="flex-row items-start gap-3 border-b">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-primary/10 text-primary">
            <Icon className="size-4.5" aria-hidden="true" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <SheetTitle className="truncate text-sm">{job.name}</SheetTitle>
            <SheetDescription className="truncate font-mono text-xs" dir="ltr">
              {job.id} · {jobSourcePath(job)}
              {target === null ? '' : ` → ${target}`}
            </SheetDescription>
          </div>
          <JobStatusBadge status={job.status} className="shrink-0" />
        </SheetHeader>

        <div className="flex flex-col gap-3 overflow-y-auto p-4">
          <dl className="grid grid-cols-3 gap-3 rounded-lg border p-3 text-xs">
            <div className="flex flex-col">
              <dd className="num font-semibold">
                {ratio === null ? <Dash /> : <Pct value={ratio} />}
              </dd>
              <dt className="text-muted-foreground">{t('jobs.log.progress')}</dt>
            </div>
            <div className="flex flex-col">
              <dd className="num font-semibold">
                <Num value={job.progress.objectsPerSec} />
              </dd>
              <dt className="text-muted-foreground">{t('jobs.stat.objectsPerSec')}</dt>
            </div>
            <div className="flex flex-col">
              <dd
                className={cn(
                  'num font-semibold',
                  job.progress.failed > 0 ? 'text-destructive' : undefined,
                )}
              >
                <Num value={job.progress.failed} />
              </dd>
              <dt className="text-muted-foreground">{t('jobs.stat.failed')}</dt>
            </div>
          </dl>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.8125rem] font-medium">{t('jobs.log.stream')}</span>
            <SegmentedControl
              options={levelOptions}
              value={level}
              onValueChange={setLevel}
              size="sm"
              className="ms-auto"
              aria-label={t('jobs.log.levelFilter')}
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                checked={follow}
                onCheckedChange={setFollow}
                aria-label={t('jobs.log.follow')}
              />
              {t('jobs.log.follow')}
            </label>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={downloadLog}
              disabled={entries.length === 0}
              aria-label={t('jobs.log.download')}
            >
              <DownloadIcon />
            </Button>
          </div>

          {logs.isError ? (
            <p className="rounded-lg border border-destructive/40 p-3 text-xs text-destructive">
              {apiError.message(logs.error)}
            </p>
          ) : logs.isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-4/6" />
            </div>
          ) : entries.length === 0 ? (
            <p className="rounded-lg border p-6 text-center text-xs text-muted-foreground">
              {t('jobs.log.empty')}
            </p>
          ) : (
            <ScrollArea ref={scrollRef} className="h-64 rounded-lg border bg-muted/40" dir="ltr">
              <pre className="p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap">
                {entries.map((entry, index) => (
                  <LogLine
                    key={`${entry.at}-${index}`}
                    entry={entry}
                    time={format.dateTime(entry.at, 'time')}
                  />
                ))}
              </pre>
            </ScrollArea>
          )}

          {failures.length === 0 ? null : (
            <div className="flex flex-col gap-1.5">
              <span className="text-[0.8125rem] font-medium">{t('jobs.log.failedObjects')}</span>
              {failures.map((entry, index) => (
                <div
                  key={`${entry.at}-${index}`}
                  className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono" dir="ltr">
                      {entry.key}
                    </span>
                    <span className="text-muted-foreground">{entry.message}</span>
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                {t('jobs.log.showingFailures', {
                  shown: failures.length,
                  total: job.progress.failed,
                })}
              </p>
            </div>
          )}
        </div>

        <SheetFooter className="flex-row items-center gap-2 border-t">
          {/*
            A finished job has nothing to pause or cancel. The buttons stay in
            place rather than disappearing — a footer that changes shape as a job
            completes makes the operator hunt for Close — but they are inert.
          */}
          {job.status === 'paused' ? (
            <Button variant="outline" size="sm" onClick={() => onResume(job)} disabled={finished}>
              <PlayIcon />
              {t('jobs.resume')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPause(job)}
              disabled={job.status !== 'running'}
            >
              <PauseIcon />
              {t('jobs.pause')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onCancel(job)} disabled={finished}>
            <BanIcon />
            {t('jobs.cancelJob')}
          </Button>
          <Button variant="ghost" size="sm" className="ms-auto" onClick={onClose}>
            {tCommon('action.close')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function LogLine({ entry, time }: { readonly entry: JobLogEntry; readonly time: string }) {
  return (
    <span className="block">
      <span className="text-muted-foreground">{time} </span>
      <span className={cn('font-semibold', LEVEL_CLASSES[entry.level])}>
        {entry.level.toUpperCase().padEnd(5)}
      </span>{' '}
      <span>{entry.message}</span>
      {entry.key === null ? null : <span className="text-muted-foreground"> · {entry.key}</span>}
    </span>
  );
}
