import type { BucketRef } from '@storage-io/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/app/Alert';
import { Checkbox } from '@/components/app/Checkbox';
import { ConfirmDialog } from '@/components/app/ConfirmDialog';
import { Bytes, Num } from '@/components/app/Format';
import { Label } from '@/components/app/Label';
import { toastProblem } from '@/lib/api/problems';
import { useEmptyBucket } from '../api';

/**
 * Empty bucket. The API answers with a `Job`, not with a finished result — a
 * bucket with millions of objects cannot be emptied inside one request — so the
 * toast points at the job rather than claiming the bucket is empty.
 */
export function EmptyBucketDialog({
  open,
  onOpenChange,
  bucket,
  objectCount,
  sizeBytes,
  onStarted,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly bucket: BucketRef;
  readonly objectCount?: number | null;
  readonly sizeBytes?: number | null;
  readonly onStarted?: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const versionsId = useId();
  const [includeVersions, setIncludeVersions] = useState(true);
  const empty = useEmptyBucket();

  function submit(): void {
    if (empty.isPending) return;
    empty.mutate(
      { serverId: bucket.serverId, bucket: bucket.bucket, includeVersions },
      {
        onSuccess: () => {
          toast.info(t('buckets.empties.started'), {
            description: t('buckets.empties.startedDetail'),
            // The job carries on after this toast; the link is how the operator
            // follows it, and /jobs is where every job's progress lives.
            action: {
              label: t('transfers.jobsLink'),
              onClick: () => void navigate({ to: '/jobs' }),
            },
          });
          onOpenChange(false);
          onStarted?.();
        },
        onError: (error) => toastProblem(error, tCommon, t('buckets.empties.failed')),
      },
    );
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      destructive
      busy={empty.isPending}
      title={t('buckets.empties.title')}
      description={t('buckets.empties.description')}
      confirmValue={bucket.bucket}
      confirmValueLabel={t('buckets.empties.submit')}
      confirmLabel={t('buckets.empties.submit')}
      onConfirm={submit}
    >
      <div className="flex flex-col gap-3">
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">{t('bucket.general.objects')}</dt>
          <dd className="text-end">
            <Num value={objectCount ?? null} />
          </dd>
          <dt className="text-muted-foreground">{t('bucket.general.size')}</dt>
          <dd className="text-end">
            <Bytes value={sizeBytes ?? null} />
          </dd>
        </dl>

        <Alert variant="destructive">
          <AlertDescription>{t('buckets.empties.startedDetail')}</AlertDescription>
        </Alert>

        <div className="flex items-start gap-2">
          <Checkbox
            id={versionsId}
            checked={includeVersions}
            onCheckedChange={(checked) => setIncludeVersions(checked === true)}
            className="mt-0.5"
          />
          <Label htmlFor={versionsId} className="text-sm font-normal">
            {t('buckets.empties.includeVersions')}
          </Label>
        </div>
      </div>
    </ConfirmDialog>
  );
}
