import type { AccessKey } from '@storage-io/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  Button,
  DatePicker,
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
import { useUpdateAccessKey } from '@/features/iam/api';
import { useApiError } from '@/lib/api/useApiError';

/**
 * Rename a key and move (or remove) its expiry. Both go through one PATCH, because
 * that is one operator intent — "this key should be called X and last until Y".
 *
 * Expiry is disabled where the provider has no key expiry, and the alert says which
 * provider, rather than letting the operator set a date the server will ignore.
 */
export function EditAccessKeyDialog({
  accessKey,
  expirySupported,
  onClose,
}: {
  readonly accessKey: AccessKey;
  readonly expirySupported: boolean;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const update = useUpdateAccessKey();

  const [name, setName] = useState(accessKey.name ?? '');
  const [expiresAt, setExpiresAt] = useState<Date | null>(
    accessKey.expiresAt === null ? null : new Date(accessKey.expiresAt),
  );

  const nameValid = name.trim().length > 0;

  const save = () => {
    update.mutate(
      {
        serverId: accessKey.serverId,
        accessKeyId: accessKey.accessKeyId,
        name: name.trim(),
        ...(expirySupported ? { expiresAt: expiresAt?.toISOString() ?? null } : {}),
      },
      {
        onSuccess: () => {
          toast.success(t('keys.edit.saved'), { description: accessKey.accessKeyId });
          onClose();
        },
        onError: (error) => apiError.toastError(error, t('keys.edit.failed')),
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
          <DialogTitle>{t('keys.edit.title')}</DialogTitle>
          <DialogDescription className="font-mono" dir="ltr">
            {accessKey.accessKeyId}
          </DialogDescription>
        </DialogHeader>

        <FormField
          label={t('keys.create.name')}
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

        <FormField label={t('keys.edit.expiresAt')} hint={t('keys.edit.expiresHint')}>
          {({ id }) => (
            <DatePicker
              id={id}
              value={expiresAt}
              onValueChange={setExpiresAt}
              clearable
              fromDate={new Date()}
              disabled={!expirySupported}
              aria-label={t('keys.edit.expiresAt')}
            />
          )}
        </FormField>

        {expirySupported ? null : (
          <Alert variant="info">
            <AlertDescription>
              {t('keys.create.noExpirySupport', { server: accessKey.serverName })}
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button type="button" onClick={save} disabled={!nameValid || update.isPending}>
            {update.isPending ? <Spinner /> : null}
            {tCommon('action.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
