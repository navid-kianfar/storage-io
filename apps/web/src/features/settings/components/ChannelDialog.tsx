import type { NotificationSettings, TestableChannel, UpdateSettingsRequest } from '@storage-io/contracts';
import { EyeIcon, EyeOffIcon, PlugZapIcon, PlusIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  OptionRow,
  SectionCard,
  Spinner,
  Switch,
} from '@/components/app';
import { useRemoveNotificationChannel, useUpdateSettings } from '@/features/settings/api';
import { useApiError } from '@/lib/api/useApiError';

/**
 * Configure one delivery channel.
 *
 * Secrets — the SMTP password, the webhook signing secret, the Telegram bot token —
 * are write-only in the contract and are never returned, so the field is always
 * empty and an empty field means "leave it as it is". Saying that in the hint
 * matters: otherwise the operator clears a working password by editing the host.
 */

export type ChannelKind = 'email' | 'webhook' | 'telegram';

export function ChannelDialog({
  kind,
  settings,
  onClose,
  onTest,
  testing,
}: {
  readonly kind: ChannelKind;
  readonly settings: NotificationSettings;
  readonly onClose: () => void;
  readonly onTest: (channel: TestableChannel) => void;
  readonly testing: TestableChannel | null;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const save = useUpdateSettings();
  const disconnect = useRemoveNotificationChannel();

  const [showSecret, setShowSecret] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  // Email
  const [host, setHost] = useState(settings.email.host);
  const [port, setPort] = useState(String(settings.email.port));
  const [secure, setSecure] = useState(settings.email.secure);
  const [username, setUsername] = useState(settings.email.username);
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState(settings.email.from);
  const [recipients, setRecipients] = useState<readonly string[]>(settings.email.to);
  const [recipientDraft, setRecipientDraft] = useState('');

  // Webhook
  const [url, setUrl] = useState(settings.webhook.url);
  const [webhookSecret, setWebhookSecret] = useState('');

  // Telegram
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState(settings.telegram.chatId);

  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const emailValid = host.trim().length > 0 && portValid && from.trim().length > 0;
  const webhookValid = /^https?:\/\/.+/.test(url.trim());
  const telegramValid = chatId.trim().length > 0;

  const canSave =
    kind === 'email' ? emailValid : kind === 'webhook' ? webhookValid : telegramValid;

  // "Configured" is the one field that makes the channel addressable — the same
  // test the channel list uses. Only a configured channel has anything to
  // disconnect, and the saved settings are what counts here, not the draft.
  const configured =
    kind === 'email'
      ? settings.email.host.length > 0
      : kind === 'webhook'
        ? settings.webhook.url.length > 0
        : settings.telegram.chatId.length > 0;

  const addRecipient = () => {
    const value = recipientDraft.trim();
    if (value.length === 0 || recipients.includes(value)) return;
    setRecipients([...recipients, value]);
    setRecipientDraft('');
  };

  const submit = () => {
    const body: UpdateSettingsRequest =
      kind === 'email'
        ? {
            notifications: {
              email: {
                host: host.trim(),
                port: portNumber,
                secure,
                username: username.trim(),
                from: from.trim(),
                to: [...recipients],
                ...(password.length > 0 ? { password } : {}),
              },
            },
          }
        : kind === 'webhook'
          ? {
              notifications: {
                webhook: {
                  url: url.trim(),
                  ...(webhookSecret.length > 0 ? { secret: webhookSecret } : {}),
                },
              },
            }
          : {
              notifications: {
                telegram: {
                  chatId: chatId.trim(),
                  ...(botToken.length > 0 ? { botToken } : {}),
                },
              },
            };

    save.mutate(body, {
      onSuccess: () => {
        toast.success(t('settings.notifications.channelSaved'), {
          description: t(`settings.notifications.channel.${kind}`),
        });
        onClose();
      },
      onError: (error) => apiError.toastError(error, t('settings.notifications.failed')),
    });
  };

  const removeChannel = () => {
    disconnect.mutate(kind, {
      onSuccess: () => {
        toast.success(t('settings.notifications.disconnected'), {
          description: t(`settings.notifications.channel.${kind}`),
        });
        setConfirmingDisconnect(false);
        onClose();
      },
      onError: (error) => {
        setConfirmingDisconnect(false);
        apiError.toastError(error, t('settings.notifications.disconnectFailed'));
      },
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(`settings.notifications.channel.${kind}`)}</DialogTitle>
          <DialogDescription>
            {t(`settings.notifications.channelDescription.${kind}`)}
          </DialogDescription>
        </DialogHeader>

        {kind === 'email' ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
              <FormField label={t('settings.notifications.email.host')}>
                {({ id }) => (
                  <Input
                    id={id}
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    className="font-mono"
                    dir="ltr"
                    placeholder="smtp.example.com"
                  />
                )}
              </FormField>
              <FormField
                label={t('settings.notifications.email.port')}
                error={portValid ? undefined : tCommon('form.invalid')}
              >
                {({ id, invalid }) => (
                  <Input
                    id={id}
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    inputMode="numeric"
                    className="num"
                    aria-invalid={invalid}
                  />
                )}
              </FormField>
            </div>

            <SectionCard flush>
              <OptionRow
                label={t('settings.notifications.email.secure')}
                hint={t('settings.notifications.email.secureHint')}
              >
                <Switch
                  checked={secure}
                  onCheckedChange={setSecure}
                  aria-label={t('settings.notifications.email.secure')}
                />
              </OptionRow>
            </SectionCard>

            <FormField label={t('settings.notifications.email.username')}>
              {({ id }) => (
                <Input
                  id={id}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                  dir="ltr"
                />
              )}
            </FormField>

            <FormField
              label={t('settings.notifications.email.password')}
              hint={t('settings.notifications.secretHint')}
            >
              {({ id }) => (
                <InputGroup>
                  <InputGroupInput
                    id={id}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type={showSecret ? 'text' : 'password'}
                    autoComplete="new-password"
                    dir="ltr"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      onClick={() => setShowSecret((visible) => !visible)}
                      aria-label={
                        showSecret ? tCommon('form.hideSecret') : tCommon('form.showSecret')
                      }
                    >
                      {showSecret ? <EyeOffIcon /> : <EyeIcon />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              )}
            </FormField>

            <FormField label={t('settings.notifications.email.from')}>
              {({ id }) => (
                <Input
                  id={id}
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  dir="ltr"
                  placeholder="storage-io@example.com"
                />
              )}
            </FormField>

            <FormField label={t('settings.notifications.email.to')}>
              {({ id }) => (
                <div className="flex flex-col gap-2">
                  {recipients.length === 0 ? null : (
                    <div className="flex flex-wrap gap-1.5">
                      {recipients.map((recipient) => (
                        <Badge key={recipient} variant="secondary" className="gap-1">
                          <span dir="ltr">{recipient}</span>
                          <button
                            type="button"
                            onClick={() =>
                              setRecipients(recipients.filter((entry) => entry !== recipient))
                            }
                            aria-label={t('settings.notifications.email.removeRecipient', {
                              recipient,
                            })}
                            className="rounded-full hover:text-destructive"
                          >
                            <XIcon className="size-3" aria-hidden="true" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Input
                      id={id}
                      value={recipientDraft}
                      onChange={(event) => setRecipientDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        addRecipient();
                      }}
                      inputMode="email"
                      dir="ltr"
                      placeholder="ops@example.com"
                      className="min-w-0 flex-1"
                    />
                    <Button type="button" variant="outline" onClick={addRecipient}>
                      <PlusIcon />
                      {tCommon('action.add')}
                    </Button>
                  </div>
                </div>
              )}
            </FormField>
          </div>
        ) : null}

        {kind === 'webhook' ? (
          <div className="flex flex-col gap-4">
            <FormField
              label={t('settings.notifications.webhook.url')}
              error={url.length > 0 && !webhookValid ? t('settings.notifications.webhook.invalidUrl') : undefined}
            >
              {({ id, invalid }) => (
                <Input
                  id={id}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  className="font-mono"
                  dir="ltr"
                  aria-invalid={invalid}
                  placeholder="https://hooks.example.com/storage-io"
                />
              )}
            </FormField>
            <FormField
              label={t('settings.notifications.webhook.secret')}
              hint={t('settings.notifications.webhook.secretHint')}
            >
              {({ id }) => (
                <InputGroup>
                  <InputGroupInput
                    id={id}
                    value={webhookSecret}
                    onChange={(event) => setWebhookSecret(event.target.value)}
                    type={showSecret ? 'text' : 'password'}
                    autoComplete="new-password"
                    dir="ltr"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      onClick={() => setShowSecret((visible) => !visible)}
                      aria-label={
                        showSecret ? tCommon('form.hideSecret') : tCommon('form.showSecret')
                      }
                    >
                      {showSecret ? <EyeOffIcon /> : <EyeIcon />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              )}
            </FormField>
          </div>
        ) : null}

        {kind === 'telegram' ? (
          <div className="flex flex-col gap-4">
            <Alert variant="info">
              <AlertDescription>{t('settings.notifications.telegram.howTo')}</AlertDescription>
            </Alert>
            <FormField
              label={t('settings.notifications.telegram.botToken')}
              hint={t('settings.notifications.secretHint')}
            >
              {({ id }) => (
                <InputGroup>
                  <InputGroupInput
                    id={id}
                    value={botToken}
                    onChange={(event) => setBotToken(event.target.value)}
                    type={showSecret ? 'text' : 'password'}
                    autoComplete="new-password"
                    dir="ltr"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      onClick={() => setShowSecret((visible) => !visible)}
                      aria-label={
                        showSecret ? tCommon('form.hideSecret') : tCommon('form.showSecret')
                      }
                    >
                      {showSecret ? <EyeOffIcon /> : <EyeIcon />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              )}
            </FormField>
            <FormField
              label={t('settings.notifications.telegram.chatId')}
              hint={t('settings.notifications.telegram.chatIdHint')}
            >
              {({ id }) => (
                <Input
                  id={id}
                  value={chatId}
                  onChange={(event) => setChatId(event.target.value)}
                  className="font-mono"
                  dir="ltr"
                  placeholder="-1001234567890"
                />
              )}
            </FormField>
          </div>
        ) : null}

        <DialogFooter className="sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onTest(kind)}
              disabled={testing !== null}
            >
              {testing === kind ? <Spinner /> : null}
              {t('settings.notifications.sendTest')}
            </Button>
            {configured ? (
              <Button
                type="button"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmingDisconnect(true)}
                disabled={disconnect.isPending}
              >
                {disconnect.isPending ? <Spinner /> : <PlugZapIcon />}
                {t('settings.notifications.disconnect')}
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {tCommon('action.cancel')}
            </Button>
            <Button type="button" onClick={submit} disabled={!canSave || save.isPending}>
              {save.isPending ? <Spinner /> : null}
              {tCommon('action.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={confirmingDisconnect}
        onOpenChange={setConfirmingDisconnect}
        destructive
        busy={disconnect.isPending}
        title={t('settings.notifications.disconnectTitle', {
          channel: t(`settings.notifications.channel.${kind}`),
        })}
        description={t('settings.notifications.disconnectDescription')}
        confirmLabel={t('settings.notifications.disconnect')}
        onConfirm={removeChannel}
      />
    </Dialog>
  );
}
