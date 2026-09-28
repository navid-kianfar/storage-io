import type { Job } from '@storage-io/contracts';
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
  Input,
  Spinner,
} from '@/components/app';
import { useUpdateJob } from '@/features/jobs/api';
import { CronText } from '@/features/jobs/components/CronText';
import { CRON_PRESETS, isCronExpression } from '@/features/jobs/cron';
import { useApiError } from '@/lib/api/useApiError';

/**
 * Rename a schedule and change when it runs. `PATCH /jobs/:id { name, schedule }`;
 * the timezone is kept as the schedule already has it, because moving a nightly job
 * into a different zone silently is how a maintenance window gets missed.
 */
export function EditScheduleDialog({
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

  const existingCron = job.schedule.kind === 'cron' ? job.schedule.cron : '0 3 * * *';
  const timezone =
    job.schedule.kind === 'cron'
      ? job.schedule.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [name, setName] = useState(job.name);
  const [cron, setCron] = useState(existingCron);
  const cronValid = isCronExpression(cron);
  const nameValid = name.trim().length > 0;

  const save = () => {
    updateJob.mutate(
      {
        jobId: job.id,
        name: name.trim(),
        schedule: { kind: 'cron', cron, timezone, enabled: true },
      },
      {
        onSuccess: () => {
          toast.success(t('jobs.toast.scheduleSaved'), { description: name.trim() });
          onClose();
        },
        onError: (error) => apiError.toastError(error, t('jobs.toast.scheduleSaveFailed')),
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('jobs.schedule.editTitle')}</DialogTitle>
          <DialogDescription>{t('jobs.schedule.editDescription')}</DialogDescription>
        </DialogHeader>

        <FormField
          label={t('jobs.wizard.name')}
          error={nameValid ? undefined : tCommon('form.required')}
        >
          {({ id, invalid }) => (
            <Input
              id={id}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={invalid}
            />
          )}
        </FormField>

        <FormField
          label={t('jobs.wizard.cronExpression')}
          error={cronValid ? undefined : t('jobs.wizard.cronInvalid')}
          hint={
            <span className="flex flex-wrap items-center gap-1">
              <CronText cron={cron} />
              <span className="text-muted-foreground">· {timezone}</span>
            </span>
          }
        >
          {({ id, invalid }) => (
            <div className="flex flex-col gap-1.5">
              <Input
                id={id}
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                className="font-mono"
                dir="ltr"
                aria-invalid={invalid}
              />
              <div className="flex flex-wrap gap-1.5">
                {CRON_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCron(preset)}
                  >
                    <span className="font-mono text-xs" dir="ltr">
                      {preset}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </FormField>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button
            type="button"
            onClick={save}
            disabled={!cronValid || !nameValid || updateJob.isPending}
          >
            {updateJob.isPending ? <Spinner /> : null}
            {tCommon('action.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
