import { JOB_CONCURRENCY_MAX, JOB_CONCURRENCY_MIN, type Job } from '@storage-io/contracts';
import {
  ArrowRightIcon,
  BanIcon,
  CalendarClockIcon,
  CopyIcon,
  EllipsisIcon,
  FileJsonIcon,
  GaugeIcon,
  PauseIcon,
  PlayIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Bytes,
  BytesPerSecond,
  Button,
  Card,
  Dash,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Duration,
  JobStatusBadge,
  Meter,
  Num,
  Pct,
  RelativeTime,
  Spinner,
  meterToneFor,
} from '@/components/app';
import { JOB_TYPE_ICONS, jobSourcePath, jobTargetPath } from '@/features/jobs/jobTypes';
import { cn } from '@/lib/utils';

/**
 * One running, queued or paused job, as the concept draws it: identity and controls
 * on top, then the progress meter, then the six inline statistics.
 *
 * Everything on it is the server's own number — `progress` arrives on the SSE
 * stream and the list query is invalidated by it, so the card animates without a
 * poll and without the browser guessing a rate. A statistic the server cannot know
 * yet (a total it is still listing, a rate on a paused job) is an em dash, never a
 * zero: a zero would read as "nothing is happening".
 */

export interface ActiveJobCardProps {
  readonly job: Job;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onCancel: () => void;
  readonly onViewLog: () => void;
  readonly onChangeConcurrency: () => void;
  readonly onSaveAsSchedule: () => void;
  readonly onCopyId: () => void;
  readonly busy: boolean;
}

export function ActiveJobCard({
  job,
  onPause,
  onResume,
  onCancel,
  onViewLog,
  onChangeConcurrency,
  onSaveAsSchedule,
  onCopyId,
  busy,
}: ActiveJobCardProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomain } = useTranslation('domain');

  const Icon = JOB_TYPE_ICONS[job.type];
  const paused = job.status === 'paused';
  const running = job.status === 'running';
  const progress = job.progress;
  const ratio =
    progress.total === null || progress.total === 0 ? null : progress.processed / progress.total;
  const target = jobTargetPath(job);

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-start gap-3 border-b px-(--card-pad) py-3">
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-lg border',
            paused ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary',
          )}
        >
          <Icon className="size-4.5" aria-hidden="true" />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{job.name}</span>
            <JobStatusBadge status={job.status} />
            <span className="font-mono text-xs text-muted-foreground" dir="ltr">
              {job.id}
            </span>
            {job.options.dryRun ? (
              <Badge variant="outline">{t('jobs.dryRunBadge')}</Badge>
            ) : null}
          </div>
          <div
            className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
            dir="ltr"
          >
            <span className="truncate font-mono">{jobSourcePath(job)}</span>
            {target === null ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{tDomain(`jobType.${job.type}`)}</span>
              </>
            ) : (
              <>
                <ArrowRightIcon className="size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
                <span className="truncate font-mono">{target}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {paused ? (
            <Button size="sm" onClick={onResume} disabled={busy}>
              {busy ? <Spinner /> : <PlayIcon />}
              {t('jobs.resume')}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onPause} disabled={busy || !running}>
              {busy ? <Spinner /> : <PauseIcon />}
              {t('jobs.pause')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            <BanIcon />
            {tCommon('action.cancel')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onViewLog}>
            <FileJsonIcon />
            {t('jobs.viewLog')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('jobs.moreActions')}>
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onViewLog}>
                <FileJsonIcon />
                {t('jobs.viewLog')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onCopyId}>
                <CopyIcon />
                {t('jobs.copyId')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onChangeConcurrency}>
                <GaugeIcon />
                {t('jobs.changeConcurrency')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onSaveAsSchedule}>
                <CalendarClockIcon />
                {t('jobs.saveAsSchedule')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onCancel}>
                <BanIcon />
                {t('jobs.cancelJob')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-col gap-3 px-(--card-pad) py-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="num">
              <Num value={progress.processed} compact />
              {progress.total === null ? null : (
                <>
                  {' / '}
                  <Num value={progress.total} compact />
                </>
              )}{' '}
              {tDomain('unit.objects')}
            </span>
            <span className="num font-semibold text-foreground">
              {ratio === null ? t('jobs.listing') : <Pct value={ratio} />}
            </span>
          </div>
          <Meter
            value={ratio}
            tone={paused ? 'warn' : meterToneFor(null)}
            size="lg"
            striped={running}
            label={t('jobs.progressOf', { name: job.name })}
          />
          {job.waitingFor === null ? null : (
            <span className="flex items-center gap-1.5 text-xs text-warning">
              <PauseIcon className="size-3.5" aria-hidden="true" />
              {t('jobs.waitingFor')} <span className="font-mono">{job.waitingFor}</span>
            </span>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
          <Stat label={t('jobs.stat.objectsPerSec')}>
            {running ? <Num value={progress.objectsPerSec} /> : <Dash />}
          </Stat>
          <Stat label={t('jobs.stat.throughput')}>
            {running ? <BytesPerSecond value={progress.bytesPerSec} /> : <Dash />}
          </Stat>
          <Stat label={t('jobs.stat.eta')}>
            {progress.etaSeconds === null || !running ? (
              <Dash />
            ) : (
              <Duration seconds={progress.etaSeconds} />
            )}
          </Stat>
          <Stat label={t('jobs.stat.failed')}>
            <Num
              value={progress.failed}
              className={progress.failed > 0 ? 'text-destructive' : undefined}
            />
          </Stat>
          <Stat label={t('jobs.stat.transferred')}>
            <Bytes value={progress.bytes} />
          </Stat>
          <Stat label={t('jobs.stat.started')}>
            {job.startedAt === null ? <Dash /> : <RelativeTime value={job.startedAt} />}
          </Stat>
        </dl>
      </div>

      {progress.failed > 0 ? (
        <div className="flex items-center gap-2 border-t bg-destructive/5 px-(--card-pad) py-2 text-xs">
          <span className="text-destructive">
            {t('jobs.failedObjects', { count: progress.failed })}
          </span>
          <Button variant="link" size="sm" className="ms-auto h-auto p-0" onClick={onViewLog}>
            {t('jobs.viewLog')}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function Stat({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dd className="num font-semibold">{children}</dd>
      <dt className="text-muted-foreground">{label}</dt>
    </div>
  );
}

/** The bounds the concurrency control is held to, re-exported so the dialog agrees. */
export const CONCURRENCY_BOUNDS = {
  min: JOB_CONCURRENCY_MIN,
  max: JOB_CONCURRENCY_MAX,
} as const;
