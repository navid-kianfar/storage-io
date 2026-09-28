import type { BucketRef } from '@storage-io/contracts';
import { useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/app/Alert';
import { Checkbox } from '@/components/app/Checkbox';
import { ConfirmDialog } from '@/components/app/ConfirmDialog';
import { Num } from '@/components/app/Format';
import { Label } from '@/components/app/Label';
import { toastProblem } from '@/lib/api/problems';
import { useBucketBulkAction, useDeleteBucket } from '../api';
import { reportBulkResult } from './bulkResult';

/**
 * Delete bucket, with the typed confirmation the concept draws.
 *
 * One bucket: the operator types its name. A selection: the operator types the
 * number of buckets — a value that is language-neutral and that nobody types by
 * reflex, which is the whole point of a typed confirmation.
 *
 * "Empty it first" is the API's `force` flag rather than a second request from
 * here; without it a bucket that still holds objects comes back as
 * `BUCKET_NOT_EMPTY` and says so.
 */
export function DeleteBucketDialog({
  open,
  onOpenChange,
  buckets,
  objectCount,
  onDeleted,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly buckets: readonly BucketRef[];
  /** Objects in the single bucket, when the caller knows it. */
  readonly objectCount?: number | null;
  readonly onDeleted?: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const forceId = useId();
  const [force, setForce] = useState(false);

  const single = useDeleteBucket();
  const bulk = useBucketBulkAction();
  const busy = single.isPending || bulk.isPending;

  const many = buckets.length > 1;
  const only = buckets.length === 1 ? buckets[0] : undefined;
  const confirmValue = only === undefined ? String(buckets.length) : only.bucket;

  function done(): void {
    onOpenChange(false);
    setForce(false);
    onDeleted?.();
  }

  function submit(): void {
    if (busy) return;
    const failureTitle = t('buckets.delete.failed');

    if (only !== undefined) {
      single.mutate(
        { serverId: only.serverId, bucket: only.bucket, force },
        {
          onSuccess: () => {
            toast.success(t('buckets.delete.deleted'), { description: only.bucket });
            done();
          },
          onError: (error) => toastProblem(error, tCommon, failureTitle),
        },
      );
      return;
    }

    bulk.mutate(
      { buckets: [...buckets], action: 'delete', payload: { force } },
      {
        onSuccess: (response) => {
          reportBulkResult(response, t, 'buckets.bulk');
          done();
        },
        onError: (error) => toastProblem(error, tCommon, failureTitle),
      },
    );
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setForce(false);
        onOpenChange(next);
      }}
      destructive
      busy={busy}
      title={many ? t('buckets.bulk.deleteTitle', { count: buckets.length }) : t('buckets.delete.title')}
      description={many ? t('buckets.bulk.deleteDescription') : t('buckets.delete.description')}
      confirmValue={confirmValue}
      confirmValueLabel={t('buckets.delete.submit')}
      confirmLabel={t('buckets.delete.submit')}
      onConfirm={submit}
    >
      <div className="flex flex-col gap-3">
        {many ? (
          <ul className="ltr-isolate max-h-32 overflow-auto rounded-md border bg-muted px-3 py-2 font-mono text-sm">
            {buckets.map((bucket) => (
              <li key={`${bucket.serverId}/${bucket.bucket}`} className="truncate">
                {bucket.bucket}
              </li>
            ))}
          </ul>
        ) : null}

        {only !== undefined && objectCount !== undefined && objectCount !== null && objectCount > 0 ? (
          <Alert variant="destructive">
            <AlertDescription>
              <Trans
                t={t}
                i18nKey="buckets.delete.stillHasObjects"
                values={{ bucket: only.bucket }}
                components={{
                  1: <code className="ltr-isolate font-mono font-medium" />,
                  2: <Num value={objectCount} className="font-semibold" />,
                }}
              />
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-start gap-2">
          <Checkbox
            id={forceId}
            checked={force}
            onCheckedChange={(checked) => setForce(checked === true)}
            className="mt-0.5"
          />
          <Label htmlFor={forceId} className="text-sm font-normal">
            {t('buckets.delete.emptyFirst')}
          </Label>
        </div>
      </div>
    </ConfirmDialog>
  );
}
