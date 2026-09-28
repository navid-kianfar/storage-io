import {
  QUOTA_THRESHOLD_DEFAULT,
  type BucketQuotaResponse,
  type QuotaMode,
  type Server,
} from '@storage-io/contracts';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/app/Alert';
import { Badge } from '@/components/app/Badge';
import { Button } from '@/components/app/Button';
import { ByteSizeInput } from '@/components/app/ByteSizeInput';
import { CardContent } from '@/components/app/Card';
import { Bytes, Pct } from '@/components/app/Format';
import { FormActions, FormRow, OptionRow } from '@/components/app/FormRow';
import { Input } from '@/components/app/Input';
import { Meter } from '@/components/app/Meter';
import { Spinner } from '@/components/app/Spinner';
import { Switch } from '@/components/app/Switch';
import { toastProblem } from '@/lib/api/problems';
import { useBucketQuota, useSaveBucketQuota, type BucketRefParams } from '../api';
import { SectionCard } from '../components/SectionCard';

/**
 * Quota. Two things make this section more than a number field:
 *
 * - a provider without a native quota still gets one, stored by storage-io and
 *   enforced only as an alert (`Quota.native === false`). The badge says which of
 *   the two the operator is looking at, because "4 TB" means different things.
 *   That is why this section is never "not supported": `bucketQuota` says whether
 *   the *driver* has one, and the API answers `PUT …/quota` either way. Only an
 *   offline server has nothing to show.
 * - the usage figures come from the same response, so the meter and the limit can
 *   never disagree.
 */

const PERCENT = 100;

export function QuotaSection({
  bucketRef,
  server,
  loading,
}: {
  readonly bucketRef: BucketRefParams;
  readonly server: Server | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tDomain } = useTranslation('domain');

  // Deliberately not gated on the `bucketQuota` capability: a driver without a
  // native quota still accepts an alert-only one, which is what /quotas lists and
  // what the create dialog offers.
  const availability = server?.status === 'offline' ? 'offline' : loading ? 'loading' : 'ready';
  const quotaQuery = useBucketQuota(bucketRef, availability === 'ready');
  const saved = quotaQuery.data;
  const quota = saved?.quota ?? null;

  return (
    <SectionCard
      id="quota"
      title={t('bucket.quota.title')}
      description={t('bucket.quota.description')}
      availability={availability === 'ready' && saved === undefined ? 'loading' : availability}
      provider={server?.provider}
      action={
        quota === null ? null : (
          <Badge variant={quota.native ? 'secondary' : 'warning'}>
            {quota.native ? tDomain('quotaSupport.native') : t('bucket.quota.alertOnly')}
          </Badge>
        )
      }
    >
      {saved === undefined ? null : (
        <QuotaForm
          key={JSON.stringify(saved)}
          bucketRef={bucketRef}
          saved={saved}
          nativeSupported={server === undefined || server.capabilities.bucketQuota === 'supported'}
        />
      )}
    </SectionCard>
  );
}

/**
 * The editable half. Mounted with the server's answer as its initial state and
 * keyed by it, so no effect has to copy one into the other.
 */
function QuotaForm({
  bucketRef,
  saved,
  nativeSupported,
}: {
  readonly bucketRef: BucketRefParams;
  readonly saved: BucketQuotaResponse;
  readonly nativeSupported: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const limitId = useId();
  const thresholdId = useId();
  const save = useSaveBucketQuota();

  const [dirty, setDirty] = useState(false);
  const [enabled, setEnabled] = useState(saved.quota !== null);
  const [limitBytes, setLimitBytes] = useState<number | null>(saved.quota?.limitBytes ?? null);
  const [mode, setMode] = useState<QuotaMode>(saved.quota?.mode ?? 'hard');
  const [thresholdPercent, setThresholdPercent] = useState(
    String(Math.round((saved.quota?.threshold ?? QUOTA_THRESHOLD_DEFAULT) * PERCENT)),
  );

  const parsedThreshold = Number.parseInt(thresholdPercent, 10);
  const thresholdValid =
    Number.isFinite(parsedThreshold) && parsedThreshold > 0 && parsedThreshold <= PERCENT;
  const canSave = dirty && thresholdValid && (!enabled || limitBytes !== null) && !save.isPending;

  const usedBytes = saved.usage.sizeBytes;
  const ratio = limitBytes === null || limitBytes <= 0 ? null : usedBytes / limitBytes;
  const freeBytes = limitBytes === null ? null : Math.max(0, limitBytes - usedBytes);

  function reset(): void {
    setEnabled(saved.quota !== null);
    setLimitBytes(saved.quota?.limitBytes ?? null);
    setMode(saved.quota?.mode ?? 'hard');
    setThresholdPercent(
      String(Math.round((saved.quota?.threshold ?? QUOTA_THRESHOLD_DEFAULT) * PERCENT)),
    );
    setDirty(false);
    toast.info(t('bucket.discard'));
  }

  function submit(): void {
    if (!canSave) return;
    save.mutate(
      {
        ref: bucketRef,
        body: {
          limitBytes: enabled ? limitBytes : null,
          mode: nativeSupported ? mode : 'alert',
          threshold: parsedThreshold / PERCENT,
        },
      },
      {
        onSuccess: () => {
          setDirty(false);
          toast.success(t('bucket.quota.saved'));
        },
        onError: (error) => toastProblem(error, tCommon, t('bucket.quota.failed')),
      },
    );
  }

  return (
    <>
      <CardContent className="pb-0">
        <OptionRow label={t('bucket.quota.enforce')} hint={t('bucket.quota.enforceHint')}>
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => {
              setEnabled(checked);
              setDirty(true);
            }}
            aria-label={t('bucket.quota.enforce')}
          />
        </OptionRow>
      </CardContent>

      <FormRow label={t('bucket.quota.limit')} hint={t('bucket.quota.limitHint')}>
        <ByteSizeInput
          id={limitId}
          value={limitBytes}
          onValueChange={(next) => {
            setLimitBytes(next);
            setDirty(true);
          }}
          disabled={!enabled}
          aria-label={t('bucket.quota.limit')}
        />
      </FormRow>

      <FormRow label={t('bucket.quota.usage')} hint={t('bucket.quota.usageHint')}>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <Meter value={ratio} size="lg" className="grow" label={bucketRef.bucket} />
            <Pct value={ratio} className="text-sm font-semibold" />
          </div>
          <span className="num text-xs text-muted-foreground">
            <Bytes value={usedBytes} /> / <Bytes value={limitBytes} />
            {freeBytes === null ? null : (
              <>
                {' · '}
                <Bytes value={freeBytes} /> {t('bucket.quota.free')}
              </>
            )}
          </span>
        </div>
      </FormRow>

      <FormRow
        label={t('bucket.quota.threshold')}
        hint={t('bucket.quota.thresholdHint')}
        htmlFor={thresholdId}
      >
        <div className="flex items-center gap-2">
          <Input
            id={thresholdId}
            value={thresholdPercent}
            inputMode="numeric"
            disabled={!enabled}
            aria-invalid={!thresholdValid}
            onChange={(event) => {
              setThresholdPercent(event.target.value);
              setDirty(true);
            }}
            className="num w-20"
          />
          <span className="text-sm text-muted-foreground">%</span>
        </div>
      </FormRow>

      <CardContent>
        <Alert variant="info">
          <AlertTitle>{t('bucket.quota.providerTitle')}</AlertTitle>
          <AlertDescription>{t('bucket.quota.providerDetail')}</AlertDescription>
        </Alert>
      </CardContent>

      <FormActions>
        <Button variant="outline" disabled={!dirty || save.isPending} onClick={reset}>
          {tCommon('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={!canSave}>
          {save.isPending ? <Spinner /> : null}
          {tCommon('action.save')}
        </Button>
      </FormActions>
    </>
  );
}
