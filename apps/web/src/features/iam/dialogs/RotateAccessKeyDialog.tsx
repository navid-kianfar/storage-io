import type { AccessKey, CreatedKey } from '@storage-io/contracts';
import { RotateCwIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Combobox,
  CopyField,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Spinner,
  type ComboboxOption,
} from '@/components/app';
import { useRotateAccessKey } from '@/features/iam/api';
import { SecretRevealDialog } from '@/features/iam/components/SecretRevealDialog';
import { isoInDays } from '@/features/iam/expiry';
import { useApiError } from '@/lib/api/useApiError';

/**
 * Rotate a key — the `/keys/$keyId/rotate` route over the access keys list.
 *
 * The grace period is the whole point of the dialog. Issuing a new key and killing
 * the old one in the same second breaks whatever was using it; keeping the old one
 * alive for a day lets the operator roll the secret out and only then let it lapse.
 * `graceSeconds: 0` is offered explicitly, for the case where the old key is the
 * reason you are rotating.
 */

const GRACE_OPTIONS = ['1h', '24h', '7d', 'now'] as const;
type GraceOption = (typeof GRACE_OPTIONS)[number];

const HOUR_SECONDS = 3600;
const GRACE_SECONDS: Readonly<Record<GraceOption, number>> = {
  '1h': HOUR_SECONDS,
  '24h': 24 * HOUR_SECONDS,
  '7d': 7 * 24 * HOUR_SECONDS,
  now: 0,
};

const EXPIRY_OPTIONS = ['90d', '1y', 'never'] as const;
type ExpiryOption = (typeof EXPIRY_OPTIONS)[number];

const EXPIRY_DAYS: Readonly<Record<Exclude<ExpiryOption, 'never'>, number>> = {
  '90d': 90,
  '1y': 365,
};

export interface RotateAccessKeyDialogProps {
  /** The key being rotated; the route (`/keys/$keyId/rotate`) names it by id. */
  readonly accessKey: AccessKey;
  readonly onClose: () => void;
}

export function RotateAccessKeyDialog({ accessKey, onClose }: RotateAccessKeyDialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const rotate = useRotateAccessKey();

  const [grace, setGrace] = useState<GraceOption>('24h');
  const [expiry, setExpiry] = useState<ExpiryOption>('90d');
  const [created, setCreated] = useState<CreatedKey | null>(null);

  const key = accessKey;

  const graceOptions = useMemo<readonly ComboboxOption<GraceOption>[]>(
    () => GRACE_OPTIONS.map((value) => ({ value, label: t(`keys.rotate.grace.${value}`) })),
    [t],
  );

  const expiryOptions = useMemo<readonly ComboboxOption<ExpiryOption>[]>(
    () => EXPIRY_OPTIONS.map((value) => ({ value, label: t(`keys.rotate.expiry.${value}`) })),
    [t],
  );

  const submit = () => {
    rotate.mutate(
      {
        serverId: key.serverId,
        accessKeyId: key.accessKeyId,
        graceSeconds: GRACE_SECONDS[grace],
        expiresAt: expiry === 'never' ? null : isoInDays(EXPIRY_DAYS[expiry]),
      },
      {
        onSuccess: (result) => setCreated(result),
        onError: (error) => apiError.toastError(error, t('keys.rotate.failed')),
      },
    );
  };

  if (created !== null) {
    return (
      <SecretRevealDialog
        created={created}
        serverName={key?.serverName ?? ''}
        onDone={() => {
          toast.success(t('keys.rotate.done'), { description: created.accessKey.accessKeyId });
          onClose();
        }}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('keys.rotate.title')}</DialogTitle>
          <DialogDescription>
            {t('keys.rotate.descriptionFor', { user: key.userName })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
            <CopyField value={key.accessKeyId} label={t('keys.copyId')} />

            <FormField label={t('keys.rotate.graceLabel')} hint={t('keys.rotate.graceHint')}>
              {({ id }) => (
                <Combobox
                  id={id}
                  options={graceOptions}
                  value={grace}
                  onValueChange={(next) => setGrace(next ?? '24h')}
                  aria-label={t('keys.rotate.graceLabel')}
                />
              )}
            </FormField>

            <FormField label={t('keys.rotate.expiryLabel')}>
              {({ id }) => (
                <Combobox
                  id={id}
                  options={expiryOptions}
                  value={expiry}
                  onValueChange={(next) => setExpiry(next ?? '90d')}
                  aria-label={t('keys.rotate.expiryLabel')}
                />
              )}
            </FormField>

            {grace === 'now' ? (
              <Alert variant="warning">
                <AlertTitle>{t('keys.rotate.immediateTitle')}</AlertTitle>
                <AlertDescription>{t('keys.rotate.immediateBody')}</AlertDescription>
              </Alert>
            ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={rotate.isPending}
          >
            {rotate.isPending ? <Spinner /> : <RotateCwIcon />}
            {t('keys.rotate.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


