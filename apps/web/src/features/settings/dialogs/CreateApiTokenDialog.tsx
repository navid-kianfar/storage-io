import { TerminalIcon, TriangleAlertIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Combobox,
  CopyField,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  Spinner,
  type ComboboxOption,
} from '@/components/app';
import { useCreateApiToken } from '@/features/settings/api';
import { useApiError } from '@/lib/api/useApiError';
import { registerDialog, type DialogProps } from '@/lib/dialogs/registry';

/**
 * A CLI token for scripts and CI: `?dialog=create-api-token`.
 *
 * Like an S3 secret, the token is shown once and cannot be retrieved, so the dialog
 * does not close on success — it swaps to the value, with the same "I have stored
 * it" gate the access-key flow uses. A token that scrolls past in a toast is a
 * token that gets regenerated an hour later.
 */

const EXPIRY_CHOICES = [30, 90, 365] as const;
const NEVER = 'never';

export function CreateApiTokenDialog({ onClose }: DialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const create = useCreateApiToken();

  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<string>('90');
  const [token, setToken] = useState<string | null>(null);
  const [stored, setStored] = useState(false);

  const expiryOptions = useMemo<readonly ComboboxOption<string>[]>(
    () => [
      ...EXPIRY_CHOICES.map((days) => ({
        value: String(days),
        label: t('settings.backup.days', { count: days }),
      })),
      { value: NEVER, label: tCommon('state.never') },
    ],
    [t, tCommon],
  );

  const nameValid = name.trim().length > 0;

  const submit = () => {
    create.mutate(
      {
        name: name.trim(),
        expiresInDays: expiry === NEVER ? null : Number.parseInt(expiry, 10),
      },
      {
        onSuccess: (result) => setToken(result.token),
        onError: (error) => apiError.toastError(error, t('settings.security.tokenFailed')),
      },
    );
  };

  if (token !== null) {
    return (
      <Dialog open>
        <DialogContent
          className="sm:max-w-lg"
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{t('settings.security.tokenCreated')}</DialogTitle>
            <DialogDescription>{t('settings.security.tokenOnce')}</DialogDescription>
          </DialogHeader>

          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>{t('settings.security.tokenWarningTitle')}</AlertTitle>
            <AlertDescription>{t('settings.security.tokenWarningBody')}</AlertDescription>
          </Alert>

          <CopyField value={token} label={t('settings.security.copyToken')} multiline />

          <label className="flex items-start gap-2.5">
            <Checkbox
              checked={stored}
              onCheckedChange={(checked) => setStored(checked === true)}
              className="mt-0.5"
            />
            <span className="text-[0.8125rem]">{t('settings.security.tokenStored')}</span>
          </label>

          <DialogFooter>
            <Button
              type="button"
              disabled={!stored}
              onClick={() => {
                toast.success(t('settings.security.tokenCreated'), { description: name.trim() });
                onClose();
              }}
            >
              {tCommon('action.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.security.newToken')}</DialogTitle>
          <DialogDescription>{t('settings.security.newTokenDescription')}</DialogDescription>
        </DialogHeader>

        <FormField
          label={t('settings.security.tokenName')}
          hint={t('settings.security.tokenNameHint')}
        >
          {({ id }) => (
            <Input
              id={id}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="terraform-ci"
              autoComplete="off"
            />
          )}
        </FormField>

        <FormField label={t('settings.security.tokenExpiry')}>
          {({ id }) => (
            <Combobox
              id={id}
              options={expiryOptions}
              value={expiry}
              onValueChange={(value) => setExpiry(value ?? '90')}
              aria-label={t('settings.security.tokenExpiry')}
            />
          )}
        </FormField>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button type="button" onClick={submit} disabled={!nameValid || create.isPending}>
            {create.isPending ? <Spinner /> : <TerminalIcon />}
            {tCommon('action.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

registerDialog('create-api-token', CreateApiTokenDialog);
