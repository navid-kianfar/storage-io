import {
  PROVIDER_LABELS,
  QUOTA_THRESHOLD_DEFAULT,
  type Bucket,
  type Provider,
  type QuotaMode,
  type QuotaRow,
} from '@storage-io/contracts';
import { BellIcon, InfoIcon, ShieldIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  ByteSizeInput,
  Bytes,
  Button,
  ChoiceCards,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Skeleton,
  Spinner,
  type ChoiceOption,
  type ComboboxOption,
} from '@/components/app';
import { useQuotas, useSetQuota } from '@/features/quotas/api';
import { useApiError } from '@/lib/api/useApiError';
import { registerDialog, type DialogProps } from '@/lib/dialogs/registry';

/**
 * Set or change a bucket's quota: `?dialog=edit-quota&d_server=…&d_bucket=…`.
 * Opened without a bucket — the page's "Set a quota" button, the command palette —
 * it asks which bucket first.
 *
 * Two facts shape it. First, a limit is a number *and* a unit, so the amount goes
 * through `ByteSizeInput`, which follows the installation's decimal or binary
 * setting and hands back bytes; the operator types the number they read everywhere
 * else. Second, whether a hard limit is even possible is the provider's decision:
 * AWS S3, R2 and Wasabi have no native bucket quota, so there the mode is forced to
 * alert-only and the card says why, instead of letting the operator save something
 * the server would ignore.
 *
 * The form is a child component mounted once its row has loaded, keyed by the
 * bucket. That is what makes its initial state the bucket's *current* quota without
 * an effect copying server data into `useState` on every change.
 */

/** Providers whose driver enforces a bucket quota server-side. */
const NATIVE_QUOTA_PROVIDERS: readonly Provider[] = ['minio', 'seaweedfs', 'ceph', 'garage'];

const PERCENT = 100;
const MIN_THRESHOLD_PERCENT = 1;
const MAX_THRESHOLD_PERCENT = 100;
const PICKER_PAGE_SIZE = 200;

export function EditQuotaDialog({ params, onClose }: DialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const serverParam = params.server ?? '';
  const bucketParam = params.bucket ?? '';
  const [picked, setPicked] = useState<string | null>(null);

  // One list request serves both jobs: finding the addressed row, and offering the
  // picker its options. The row carries the bucket, its usage, its quota and the
  // provider's support level, so nothing else has to be fetched.
  const quotas = useQuotas({ filter: 'all', page: 1, pageSize: PICKER_PAGE_SIZE });
  const rows = useMemo(() => quotas.data?.items ?? [], [quotas.data]);

  const addressedKey =
    bucketParam.length > 0 ? `${serverParam}/${bucketParam}` : (picked ?? null);
  const row = rows.find((entry) => keyOf(entry.bucket) === addressedKey);

  const options = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      rows.map((entry) => ({
        value: keyOf(entry.bucket),
        label: entry.bucket.name,
        description: entry.bucket.serverName,
        disabled: entry.supported === 'unavailable',
      })),
    [rows],
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {row?.bucket.quota == null ? t('quotas.edit.setTitle') : t('quotas.edit.title')}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1">
            {row === undefined ? (
              t('quotas.edit.pickPrompt')
            ) : (
              <>
                <span className="font-mono">{row.bucket.name}</span>
                <span>{t('quotas.edit.on')}</span>
                <span className="font-mono">{row.bucket.serverName}</span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {quotas.isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : quotas.isError ? (
          <p className="text-sm text-destructive">{apiError.message(quotas.error)}</p>
        ) : row === undefined ? (
          <>
            <FormField label={t('quotas.edit.bucket')}>
              {({ id }) => (
                <Combobox
                  id={id}
                  options={options}
                  value={picked}
                  onValueChange={setPicked}
                  placeholder={t('quotas.edit.pickPlaceholder')}
                  aria-label={t('quotas.edit.bucket')}
                />
              )}
            </FormField>
            {bucketParam.length > 0 ? (
              <p className="text-sm text-muted-foreground">{t('quotas.edit.notFound')}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {tCommon('action.cancel')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <QuotaForm key={keyOf(row.bucket)} row={row} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function keyOf(bucket: Bucket): string {
  return `${bucket.serverName}/${bucket.name}`;
}

function QuotaForm({ row, onClose }: { readonly row: QuotaRow; readonly onClose: () => void }) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomain } = useTranslation('domain');
  const apiError = useApiError();
  const setQuota = useSetQuota();

  const bucket = row.bucket;
  const existing = bucket.quota;

  const [limitBytes, setLimitBytes] = useState<number | null>(existing?.limitBytes ?? null);
  const [mode, setMode] = useState<QuotaMode>(existing?.mode ?? 'hard');
  const [thresholdPercent, setThresholdPercent] = useState(
    String(Math.round((existing?.threshold ?? QUOTA_THRESHOLD_DEFAULT) * PERCENT)),
  );

  const nativeSupported = NATIVE_QUOTA_PROVIDERS.includes(bucket.provider);
  const effectiveMode: QuotaMode = nativeSupported ? mode : 'alert';

  const modeOptions = useMemo<readonly ChoiceOption<QuotaMode>[]>(
    () => [
      {
        value: 'hard',
        label: tDomain('quotaMode.hard'),
        description: nativeSupported
          ? t('quotas.edit.hardHint')
          : t('quotas.edit.hardUnavailable', { provider: PROVIDER_LABELS[bucket.provider] }),
        media: <ShieldIcon className="size-4 text-primary" />,
        disabled: !nativeSupported,
      },
      {
        value: 'alert',
        label: tDomain('quotaMode.alert'),
        description: t('quotas.edit.alertHint'),
        media: <BellIcon className="size-4 text-primary" />,
      },
    ],
    [bucket.provider, nativeSupported, t, tDomain],
  );

  const limitValid = limitBytes !== null && limitBytes > 0;
  const parsedThreshold = Number(thresholdPercent);
  const thresholdValid =
    Number.isInteger(parsedThreshold) &&
    parsedThreshold >= MIN_THRESHOLD_PERCENT &&
    parsedThreshold <= MAX_THRESHOLD_PERCENT;

  const usedBytes = bucket.sizeBytes;
  const limitBelowUsage = limitBytes !== null && usedBytes !== null && limitBytes < usedBytes;

  const save = useCallback(
    (nextLimitBytes: number | null) => {
      setQuota.mutate(
        {
          serverId: bucket.serverId,
          bucket: bucket.name,
          limitBytes: nextLimitBytes,
          mode: effectiveMode,
          threshold: parsedThreshold / PERCENT,
        },
        {
          onSuccess: () => {
            toast.success(
              nextLimitBytes === null ? t('quotas.toast.removed') : t('quotas.toast.saved'),
              { description: `${bucket.serverName} / ${bucket.name}` },
            );
            onClose();
          },
          onError: (error) => apiError.toastError(error, t('quotas.toast.saveFailed')),
        },
      );
    },
    [
      apiError,
      bucket.name,
      bucket.serverId,
      bucket.serverName,
      effectiveMode,
      onClose,
      parsedThreshold,
      setQuota,
      t,
    ],
  );

  return (
    <>
      <FormField
        label={t('quotas.edit.limit')}
        hint={
          <>
            {t('quotas.edit.currentlyUsed')} <Bytes value={usedBytes} />
          </>
        }
        error={limitBelowUsage ? t('quotas.edit.belowUsage') : undefined}
      >
        {({ id }) => (
          <ByteSizeInput
            id={id}
            value={limitBytes}
            onValueChange={setLimitBytes}
            aria-label={t('quotas.edit.limit')}
            unitLabel={t('quotas.edit.unit')}
          />
        )}
      </FormField>

      <div className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium">{t('quotas.edit.enforcement')}</span>
        <ChoiceCards
          options={modeOptions}
          value={effectiveMode}
          onValueChange={setMode}
          columns={2}
          aria-label={t('quotas.edit.enforcement')}
        />
      </div>

      <FormField
        label={t('quotas.edit.threshold')}
        hint={t('quotas.edit.thresholdHint')}
        error={thresholdValid ? undefined : tCommon('form.invalid')}
      >
        {({ id, invalid }) => (
          <InputGroup className="max-w-32">
            <InputGroupInput
              id={id}
              value={thresholdPercent}
              onChange={(event) => setThresholdPercent(event.target.value)}
              inputMode="numeric"
              aria-invalid={invalid}
              className="num"
            />
            <InputGroupAddon align="inline-end">%</InputGroupAddon>
          </InputGroup>
        )}
      </FormField>

      <Alert variant="info">
        <InfoIcon />
        <AlertTitle>{t('quotas.edit.providerNoteTitle')}</AlertTitle>
        <AlertDescription>{t('quotas.edit.providerNoteBody')}</AlertDescription>
      </Alert>

      <DialogFooter className="sm:justify-between">
        {existing === null ? (
          <span />
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => save(null)}
            disabled={setQuota.isPending}
          >
            {t('quotas.edit.removeQuota')}
          </Button>
        )}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => save(limitBytes)}
            disabled={!limitValid || !thresholdValid || setQuota.isPending}
          >
            {setQuota.isPending ? <Spinner /> : null}
            {tCommon('action.save')}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

registerDialog('edit-quota', EditQuotaDialog);
