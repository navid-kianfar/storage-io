import type { RotateServerCredentialsRequest } from '@storage-io/contracts';
import { KeyRoundIcon, RotateCwIcon, TriangleAlertIcon, WandSparklesIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  ChoiceCards,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  Spinner,
  type ChoiceOption,
} from '@/components/app';
import { useRotateServerCredentials, useServer } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { registerDialog, type DialogProps } from '@/lib/dialogs/registry';

/**
 * Rotate the admin credentials storage-io uses for a server.
 *
 * `auto` is the path the concept draws: the API asks the IAM driver for a fresh
 * key, verifies it, swaps the stored pair and disables the old one. It needs an
 * IAM driver, so a provider without one (R2, generic S3) only gets `manual`,
 * where the operator pastes a key they created on the server themselves. The mode
 * picker says which is available rather than failing after the fact.
 */
type Mode = 'auto' | 'manual';

export function RotateCredentialsDialog({ params, onClose }: DialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const serverId = params.server ?? '';
  const server = useServer(serverId);
  const rotate = useRotateServerCredentials();

  const autoSupported = server.data?.capabilities.accessKeys === 'supported';
  const [mode, setMode] = useState<Mode>('auto');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');

  const effectiveMode: Mode = autoSupported === false ? 'manual' : mode;

  const options: readonly ChoiceOption<Mode>[] = [
    {
      value: 'auto',
      label: t('servers.rotate.auto'),
      description: autoSupported === false
        ? t('servers.rotate.autoUnavailable')
        : t('servers.rotate.autoHint'),
      media: <WandSparklesIcon className="size-4 text-primary" />,
      disabled: autoSupported === false,
    },
    {
      value: 'manual',
      label: t('servers.rotate.manual'),
      description: t('servers.rotate.manualHint'),
      media: <KeyRoundIcon className="size-4 text-primary" />,
    },
  ];

  const canSubmit =
    server.data !== undefined &&
    (effectiveMode === 'auto' ||
      (accessKeyId.trim().length > 0 && secretAccessKey.length > 0));

  const onConfirm = useCallback(() => {
    const body: RotateServerCredentialsRequest =
      effectiveMode === 'auto'
        ? { mode: 'auto' }
        : { mode: 'manual', accessKeyId: accessKeyId.trim(), secretAccessKey };
    rotate.mutate(
      { serverId, body },
      {
        onSuccess: (response) => {
          toast.success(t('servers.toast.rotated'), {
            description: t('servers.toast.rotatedDetail', {
              name: response.server.name,
              keyId: response.server.accessKeyId,
            }),
          });
          onClose();
        },
        onError: (error) => apiError.toastError(error, t('servers.toast.rotateFailed')),
      },
    );
  }, [accessKeyId, apiError, effectiveMode, onClose, rotate, secretAccessKey, serverId, t]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('servers.rotate.title')}</DialogTitle>
          <DialogDescription>{t('servers.rotate.description')}</DialogDescription>
        </DialogHeader>

        <ChoiceCards
          options={options}
          value={effectiveMode}
          onValueChange={setMode}
          orientation="rows"
          aria-label={t('servers.rotate.modeLabel')}
        />

        {effectiveMode === 'manual' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('servers.connection.accessKeyId')}>
              {({ id }) => (
                <Input
                  id={id}
                  value={accessKeyId}
                  onChange={(event) => setAccessKeyId(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="ltr-isolate font-mono"
                />
              )}
            </FormField>
            <FormField label={t('servers.connection.secret')}>
              {({ id }) => (
                <Input
                  id={id}
                  type="password"
                  value={secretAccessKey}
                  onChange={(event) => setSecretAccessKey(event.target.value)}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="ltr-isolate font-mono"
                />
              )}
            </FormField>
          </div>
        ) : null}

        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>{t('servers.rotate.warnTitle')}</AlertTitle>
          <AlertDescription>{t('servers.rotate.warnBody')}</AlertDescription>
        </Alert>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button type="button" onClick={onConfirm} disabled={!canSubmit || rotate.isPending}>
            {rotate.isPending ? <Spinner /> : <RotateCwIcon />}
            {t('servers.rotate.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

registerDialog('rotate-server-credentials', RotateCredentialsDialog);
