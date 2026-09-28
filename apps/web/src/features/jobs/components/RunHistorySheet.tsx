import type { Job } from '@storage-io/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bytes,
  Button,
  Dash,
  DateTime,
  Duration,
  EmptyState,
  JobStatusBadge,
  Num,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
} from '@/components/app';
import { useJobRuns } from '@/features/jobs/api';
import { useApiError } from '@/lib/api/useApiError';
import { HistoryIcon } from 'lucide-react';

/**
 * Every run of a recurring schedule. Each run is its own `Job` with `parentId` set,
 * so this is the same shape as the history table — a list, not a summary, because
 * the question an operator brings here is "which night did it start failing?".
 */

const RUNS_PAGE_SIZE = 20;

export function RunHistorySheet({
  job,
  onClose,
}: {
  readonly job: Job;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const [page, setPage] = useState(1);
  const runs = useJobRuns(job.id, page);

  const items = runs.data?.items ?? [];
  const total = runs.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / RUNS_PAGE_SIZE));

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle className="text-sm">{t('jobs.schedule.runHistory')}</SheetTitle>
          <SheetDescription className="truncate">{job.name}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
          {runs.isError ? (
            <EmptyState
              icon={HistoryIcon}
              title={tCommon('state.error')}
              description={apiError.message(runs.error)}
            />
          ) : runs.isLoading ? (
            <>
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </>
          ) : items.length === 0 ? (
            <EmptyState icon={HistoryIcon} title={t('jobs.schedule.noRuns')} />
          ) : (
            items.map((run) => (
              <div key={run.id} className="flex flex-col gap-1.5 rounded-lg border p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <JobStatusBadge status={run.status} />
                  <span className="font-mono text-muted-foreground" dir="ltr">
                    {run.id}
                  </span>
                  <span className="ms-auto text-muted-foreground">
                    <DateTime value={run.finishedAt ?? run.startedAt ?? run.createdAt} />
                  </span>
                </div>
                <dl className="grid grid-cols-3 gap-2">
                  <div className="flex flex-col">
                    <dd className="num font-semibold">
                      <Num value={run.progress.processed} compact />
                    </dd>
                    <dt className="text-muted-foreground">{t('jobs.column.objects')}</dt>
                  </div>
                  <div className="flex flex-col">
                    <dd className="num font-semibold">
                      <Bytes value={run.progress.bytes} />
                    </dd>
                    <dt className="text-muted-foreground">{t('jobs.column.size')}</dt>
                  </div>
                  <div className="flex flex-col">
                    <dd className="num font-semibold">
                      <RunDuration startedAt={run.startedAt} finishedAt={run.finishedAt} />
                    </dd>
                    <dt className="text-muted-foreground">{t('jobs.column.duration')}</dt>
                  </div>
                </dl>
                {run.progress.failed === 0 ? null : (
                  <span className="text-destructive">
                    {t('jobs.failedObjects', { count: run.progress.failed })}
                  </span>
                )}
              </div>
            ))
          )}
        </div>

        <SheetFooter className="flex-row items-center gap-2 border-t">
          <span className="text-xs text-muted-foreground">
            {tCommon('table.pageOf', { page, pages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ms-auto"
            disabled={page <= 1}
            onClick={() => setPage((current) => current - 1)}
          >
            {tCommon('table.previousPage')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage((current) => current + 1)}
          >
            {tCommon('table.nextPage')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function RunDuration({
  startedAt,
  finishedAt,
}: {
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}) {
  if (startedAt === null || finishedAt === null) return <Dash />;
  const seconds = Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return <Dash />;
  return <Duration seconds={seconds} />;
}
