import {
  NOTIFICATION_RULE_KEYS,
  SETTINGS_DEFAULTS,
  type NotificationRule,
  type NotificationRules,
  type NotificationSettings,
  type Settings,
  type TestableChannel,
} from '@storage-io/contracts';
import { MailIcon, SendIcon, SettingsIcon, WebhookIcon, type LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Button,
  Checkbox,
  FormActions,
  FormRow,
  SectionCard,
  Skeleton,
  Spinner,
  Switch,
} from '@/components/app';
import { ChannelDialog, type ChannelKind } from '@/features/settings/components/ChannelDialog';
import { useTestNotification, useUpdateSettings } from '@/features/settings/api';
import { useApiError } from '@/lib/api/useApiError';

/**
 * Three delivery channels and the matrix that decides which events use them.
 *
 * The matrix is the page's most dangerous control, so it is explicit rather than
 * clever: one checkbox per event per channel, saved as a whole. A channel that is
 * switched off greys its whole column, because a tick in a column nothing is
 * listening on is exactly how an alert goes unnoticed for a month.
 *
 * "Test" sends through the real channel (`POST /settings/notifications/test`) and
 * reports what the server said — not a toast that claims success on a 202.
 */

const CHANNEL_ICONS: Readonly<Record<ChannelKind, LucideIcon>> = {
  email: MailIcon,
  webhook: WebhookIcon,
  telegram: SendIcon,
};

/** The matrix columns: the in-app list plus every channel that can be configured. */
const RULE_CHANNELS = ['inApp', 'email', 'webhook', 'telegram'] as const;
type RuleChannel = (typeof RULE_CHANNELS)[number];

export function NotificationsSection({
  settings,
  loading,
}: {
  readonly settings: Settings | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');

  if (loading || settings === undefined) {
    return (
      <SectionCard
        title={t('settings.notifications.title')}
        description={t('settings.notifications.description')}
      >
        <Skeleton className="h-48 w-full" />
      </SectionCard>
    );
  }

  return (
    <NotificationsForm
      key={JSON.stringify(settings.notifications)}
      saved={settings.notifications}
    />
  );
}

function NotificationsForm({ saved }: { readonly saved: NotificationSettings }) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const save = useUpdateSettings();
  const test = useTestNotification();

  const [rules, setRules] = useState<NotificationRules>(saved.rules);
  const [configuring, setConfiguring] = useState<ChannelKind | null>(null);
  const [testing, setTesting] = useState<TestableChannel | null>(null);

  const dirty = JSON.stringify(rules) !== JSON.stringify(saved.rules);

  const channels = useMemo(
    () =>
      [
        {
          kind: 'email' as const,
          enabled: saved.email.enabled,
          summary:
            saved.email.host.length > 0
              ? `${saved.email.host}:${String(saved.email.port)}`
              : t('settings.notifications.notConfigured'),
          configured: saved.email.host.length > 0,
        },
        {
          kind: 'webhook' as const,
          enabled: saved.webhook.enabled,
          summary:
            saved.webhook.url.length > 0
              ? saved.webhook.url
              : t('settings.notifications.notConfigured'),
          configured: saved.webhook.url.length > 0,
        },
        {
          kind: 'telegram' as const,
          enabled: saved.telegram.enabled,
          summary:
            saved.telegram.chatId.length > 0
              ? `chat ${saved.telegram.chatId}`
              : t('settings.notifications.notConfigured'),
          configured: saved.telegram.chatId.length > 0,
        },
      ] as const,
    [saved, t],
  );

  const channelEnabled: Readonly<Record<RuleChannel, boolean>> = {
    inApp: true,
    email: saved.email.enabled,
    webhook: saved.webhook.enabled,
    telegram: saved.telegram.enabled,
  };

  const toggleChannel = (kind: ChannelKind, enabled: boolean) => {
    save.mutate(
      { notifications: { [kind]: { enabled } } },
      {
        onSuccess: () =>
          toast.success(
            enabled
              ? t('settings.notifications.channelEnabled')
              : t('settings.notifications.channelDisabled'),
            { description: t(`settings.notifications.channel.${kind}`) },
          ),
        onError: (error) => apiError.toastError(error, t('settings.notifications.failed')),
      },
    );
  };

  const runTest = (channel: TestableChannel) => {
    setTesting(channel);
    test.mutate(
      { channel },
      {
        onSuccess: (result) => {
          setTesting(null);
          if (result.ok) {
            toast.success(t('settings.notifications.testSent'), { description: result.detail });
            return;
          }
          toast.error(t('settings.notifications.testFailed'), { description: result.detail });
        },
        onError: (error) => {
          setTesting(null);
          apiError.toastError(error, t('settings.notifications.testFailed'));
        },
      },
    );
  };

  const setRule = (key: keyof NotificationRules, channel: RuleChannel, value: boolean) => {
    setRules((current) => {
      const rule: NotificationRule = { ...current[key], [channel]: value };
      return { ...current, [key]: rule };
    });
  };

  const submit = () => {
    save.mutate(
      { notifications: { rules } },
      {
        onSuccess: () => toast.success(t('settings.notifications.saved')),
        onError: (error) => apiError.toastError(error, t('settings.notifications.failed')),
      },
    );
  };

  return (
    <>
      <SectionCard
        flush
        title={t('settings.notifications.title')}
        description={t('settings.notifications.description')}
        footer={
          <FormActions>
            <Button
              variant="outline"
              disabled={!dirty}
              onClick={() => setRules(saved.rules)}
            >
              {tCommon('action.cancel')}
            </Button>
            <Button onClick={submit} disabled={!dirty || save.isPending}>
              {save.isPending ? <Spinner /> : null}
              {t('settings.saveChanges')}
            </Button>
          </FormActions>
        }
      >
        <FormRow
          label={t('settings.notifications.channels')}
          hint={t('settings.notifications.channelsHint')}
        >
          <div className="flex flex-col gap-2">
            {channels.map((channel) => {
              const Icon = CHANNEL_ICONS[channel.kind];
              return (
                <div
                  key={channel.kind}
                  className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  {/*
                    A floor rather than `min-w-0`: the three controls are all
                    `shrink-0`, so with a zero floor this column absorbs every
                    pixel of shrinking and collapses to nothing at 375px — the
                    name then overflows and paints across the buttons instead of
                    the row wrapping. 8rem is enough for the longest channel name
                    and forces the wrap at narrow widths.
                  */}
                  <div className="flex min-w-[8rem] flex-1 flex-col">
                    <span className="truncate text-[0.8125rem] font-medium">
                      {t(`settings.notifications.channel.${channel.kind}`)}
                    </span>
                    <span className="truncate font-mono text-xs text-muted-foreground" dir="ltr">
                      {channel.summary}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfiguring(channel.kind)}
                  >
                    <SettingsIcon />
                    {channel.configured
                      ? t('settings.notifications.configure')
                      : t('settings.notifications.connect')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!channel.configured || testing !== null}
                    onClick={() => runTest(channel.kind)}
                  >
                    {testing === channel.kind ? <Spinner /> : null}
                    {tCommon('action.test')}
                  </Button>
                  <Switch
                    checked={channel.enabled}
                    disabled={!channel.configured || save.isPending}
                    onCheckedChange={(next) => toggleChannel(channel.kind, next)}
                    aria-label={t('settings.notifications.enableChannel', {
                      channel: t(`settings.notifications.channel.${channel.kind}`),
                    })}
                  />
                </div>
              );
            })}
          </div>
        </FormRow>

        <FormRow
          label={t('settings.notifications.events')}
          hint={t('settings.notifications.eventsHint')}
        >
          <div className="overflow-x-auto">
            <div
              role="grid"
              aria-label={t('settings.notifications.events')}
              className="min-w-lg"
            >
              <div role="row" className="grid grid-cols-[minmax(0,1fr)_repeat(4,5rem)] border-b pb-2">
                <span role="columnheader" className="text-xs font-medium text-muted-foreground">
                  {t('settings.notifications.event')}
                </span>
                {RULE_CHANNELS.map((channel) => (
                  <span
                    key={channel}
                    role="columnheader"
                    className="text-center text-xs font-medium text-muted-foreground"
                  >
                    {t(`settings.notifications.column.${channel}`)}
                  </span>
                ))}
              </div>
              {NOTIFICATION_RULE_KEYS.map((key) => (
                <div
                  key={key}
                  role="row"
                  className="grid grid-cols-[minmax(0,1fr)_repeat(4,5rem)] items-center border-b py-2 last:border-b-0"
                >
                  <span role="gridcell" className="pe-2 text-[0.8125rem]">
                    {t(`settings.notifications.rule.${key}`)}
                  </span>
                  {RULE_CHANNELS.map((channel) => (
                    <span key={channel} role="gridcell" className="flex justify-center">
                      <Checkbox
                        checked={rules[key][channel]}
                        disabled={!channelEnabled[channel]}
                        onCheckedChange={(checked) => setRule(key, channel, checked === true)}
                        aria-label={t('settings.notifications.ruleLabel', {
                          event: t(`settings.notifications.rule.${key}`),
                          channel: t(`settings.notifications.column.${channel}`),
                        })}
                      />
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </FormRow>
      </SectionCard>

      {configuring === null ? null : (
        <ChannelDialog
          kind={configuring}
          settings={saved}
          onClose={() => setConfiguring(null)}
          onTest={runTest}
          testing={testing}
        />
      )}
    </>
  );
}

/** The defaults a fresh database starts from, for the reset path. */
export const NOTIFICATION_DEFAULTS = SETTINGS_DEFAULTS.notifications;
