import { JOB_CONCURRENCY_MAX, JOB_CONCURRENCY_MIN, type Job } from '@storage-io/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Num,
  Slider,
  Spinner,
} from '@/components/app';
import { useUpdateJob } from '@/features/jobs/api';
import { useApiError } from '@/lib/api/useApiError';

/**
 * Change a running job's worker count. `PATCH /jobs/:id { concurrency }` applies it
 * live — the job is not restarted, which is why this is a one-field dialog and not
 * a stop-and-recreate flow.
 */
export function ConcurrencyDialog({
  job,
  onClose,
}: {
  readonly job: Job;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const updateJob = useUpdateJob();
  const [concurrency, setConcurrency] = useState(job.options.concurrency);

  const save = () => {
    updateJob.mutate(
      { jobId: job.id, concurrency },
      {
        onSuccess: () => {
          toast.success(t('jobs.toast.concurrencyChanged'), {
            description: `${job.name} · ${String(concurrency)}`,
          });
          onClose();
        },
        onError: (error) => apiError.toastError(error, t('jobs.toast.concurrencyFailed')),
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('jobs.changeConcurrency')}</DialogTitle>
          <DialogDescription>{t('jobs.concurrency.description')}</DialogDescription>
        </DialogHeader>

        <FormField label={t('jobs.wizard.concurrency')} hint={t('jobs.wizard.concurrencyHint')}>
          {({ id }) => (
            <div className="flex items-center gap-3">
              <Slider
                id={id}
                min={JOB_CONCURRENCY_MIN}
                max={JOB_CONCURRENCY_MAX}
                step={1}
                value={[concurrency]}
                onValueChange={([next]) => setConcurrency(next ?? job.options.concurrency)}
                className="flex-1"
                aria-label={t('jobs.wizard.concurrency')}
              />
              <span className="num w-24 shrink-0 text-end text-xs">
                <Num value={concurrency} /> {t('jobs.wizard.parallel')}
              </span>
            </div>
          )}
        </FormField>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button type="button" onClick={save} disabled={updateJob.isPending}>
            {updateJob.isPending ? <Spinner /> : null}
            {tCommon('action.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
