import {
  QUOTA_THRESHOLD_DEFAULT,
  type BucketQuotaBody,
  type BucketRef,
  type QuotaMode,
} from '@storage-io/contracts';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/app/Button';
import { ByteSizeInput } from '@/components/app/ByteSizeInput';
import { Combobox } from '@/components/app/Combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/app/Dialog';
import { FormRow, OptionRow } from '@/components/app/FormRow';
import { Input } from '@/components/app/Input';
import { Spinner } from '@/components/app/Spinner';
import { Switch } from '@/components/app/Switch';
import { toastProblem } from '@/lib/api/problems';
import { useBucketBulkAction, useSaveBucketQuota } from '../api';
import { reportBulkResult } from './bulkResult';

/**
 * Edit quota, for one bucket or for a selection.
 *
 * One bucket goes through `PUT …/quota`; a selection goes through
 * `POST /buckets/bulk` — one request, never a loop, which is also why a partial
 * failure is reported per bucket rather than as "something went wrong".
 */

const PERCENT = 100;

export interface BucketQuotaDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** One or many buckets. The title and the request path follow from the count. */
  readonly buckets: readonly BucketRef[];
  readonly initial?: BucketQuotaBody | null;
  readonly onSaved?: () => void;
}

export function BucketQuotaDialog({
  open,
  onOpenChange,
  buckets,
  initial,
  onSaved,
}: BucketQuotaDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <BucketQuotaDialogBody
          buckets={buckets}
          initial={initial ?? null}
          onDone={() => {
            onOpenChange(false);
            onSaved?.();
          }}
        />
      ) : null}
    </Dialog>
  );
}

function BucketQuotaDialogBody({
  buckets,
  initial,
  onDone,
}: {
  readonly buckets: readonly BucketRef[];
  readonly initial: BucketQuotaBody | null;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomain } = useTranslation('domain');
  const limitId = useId();
  const thresholdId = useId();

  const [enabled, setEnabled] = useState(initial !== null && initial.limitBytes !== null);
  const [limitBytes, setLimitBytes] = useState<number | null>(initial?.limitBytes ?? null);
  const [mode, setMode] = useState<QuotaMode>(initial?.mode ?? 'hard');
  const [thresholdPercent, setThresholdPercent] = useState(
    String(Math.round((initial?.threshold ?? QUOTA_THRESHOLD_DEFAULT) * PERCENT)),
  );

  const single = useSaveBucketQuota();
  const bulk = useBucketBulkAction();
  const busy = single.isPending || bulk.isPending;

  const parsedThreshold = Number.parseInt(thresholdPercent, 10);
  const thresholdValid =
    Number.isFinite(parsedThreshold) && parsedThreshold > 0 && parsedThreshold <= PERCENT;
  const canSubmit = !busy && thresholdValid && (!enabled || limitBytes !== null);

  function body(): BucketQuotaBody {
    return {
      limitBytes: enabled ? limitBytes : null,
      mode,
      threshold: parsedThreshold / PERCENT,
    };
  }

  function submit(): void {
    if (!canSubmit) return;
    const payload = body();
    const failureTitle = t('buckets.quotaDialog.failed');

    if (buckets.length === 1) {
      const ref = buckets[0]!;
      single.mutate(
        { ref: { serverId: ref.serverId, bucket: ref.bucket }, body: payload },
        {
          onSuccess: () => {
            toast.success(t('buckets.quotaDialog.saved'));
            onDone();
          },
          onError: (error) => toastProblem(error, tCommon, failureTitle),
        },
      );
      return;
    }

    bulk.mutate(
      { buckets: [...buckets], action: 'quota', payload },
      {
        onSuccess: (response) => {
          reportBulkResult(response, t, 'buckets.bulk');
          onDone();
        },
        onError: (error) => toastProblem(error, tCommon, failureTitle),
      },
    );
  }

  const many = buckets.length > 1;

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {many
            ? t('buckets.quotaDialog.titleMany', { count: buckets.length })
            : t('buckets.quotaDialog.title')}
        </DialogTitle>
        <DialogDescription>{t('bucket.quota.description')}</DialogDescription>
      </DialogHeader>

      <div className="-mx-(--card-pad) border-t">
        <div className="px-(--card-pad)">
          <OptionRow label={t('buckets.quotaDialog.enforce')} hint={t('buckets.quotaDialog.enforceHint')}>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={t('buckets.quotaDialog.enforce')}
            />
          </OptionRow>
        </div>
        <FormRow label={t('buckets.quotaDialog.limit')} hint={t('bucket.quota.limitHint')}>
          <ByteSizeInput
            id={limitId}
            value={limitBytes}
            onValueChange={setLimitBytes}
            disabled={!enabled}
            aria-label={t('buckets.quotaDialog.limit')}
          />
        </FormRow>
        <FormRow label={t('buckets.quotaDialog.mode')} hint={t('bucket.quota.providerDetail')}>
          <Combobox
            options={[
              { value: 'hard', label: tDomain('quotaMode.hard') },
              { value: 'alert', label: tDomain('quotaMode.alert') },
            ]}
            value={mode}
            onValueChange={(next) => setMode(next ?? 'hard')}
            disabled={!enabled}
            aria-label={t('buckets.quotaDialog.mode')}
            className="w-56"
          />
        </FormRow>
        <FormRow
          label={t('buckets.quotaDialog.threshold')}
          hint={t('buckets.quotaDialog.thresholdHint')}
          htmlFor={thresholdId}
        >
          <div className="flex items-center gap-2">
            <Input
              id={thresholdId}
              value={thresholdPercent}
              inputMode="numeric"
              disabled={!enabled}
              aria-invalid={!thresholdValid}
              onChange={(event) => setThresholdPercent(event.target.value)}
              className="num w-20"
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
        </FormRow>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={busy}>
          {tCommon('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {busy ? <Spinner /> : null}
          {tCommon('action.save')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
