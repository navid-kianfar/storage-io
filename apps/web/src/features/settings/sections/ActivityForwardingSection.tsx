import {
  SETTINGS_DEFAULTS,
  SYSLOG_FORMATS,
  SYSLOG_PROTOCOLS,
  type Settings,
  type SyslogSettings,
} from '@storage-io/contracts';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Button,
  Combobox,
  FormActions,
  FormRow,
  Input,
  SectionCard,
  Skeleton,
  Spinner,
  Switch,
  type ComboboxOption,
} from '@/components/app';
import { useTestNotification, useUpdateSettings } from '@/features/settings/api';
import { useApiError } from '@/lib/api/useApiError';

/**
 * Forward the activity log to a syslog collector, in addition to storing it.
 *
 * Syslog is a sink, not a notification channel: it receives *every* event, not the
 * ones the rules select. That is why it has its own section rather than a fourth
 * column in the notification matrix — the API's own contract draws the same line
 * (`TESTABLE_CHANNELS` includes syslog; `NOTIFICATION_CHANNELS` does not).
 */

const FACILITY_MIN = 0;
const FACILITY_MAX = 23;

export function ActivityForwardingSection({
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
        title={t('settings.syslog.title')}
        description={t('settings.syslog.description')}
      >
        <Skeleton className="h-32 w-full" />
      </SectionCard>
    );
  }

  return <SyslogForm key={JSON.stringify(settings.activity.syslog)} saved={settings.activity.syslog} />;
}

function SyslogForm({ saved }: { readonly saved: SyslogSettings }) {
  const { t } = useTranslation('pages');
  const apiError = useApiError();
  const save = useUpdateSettings();
  const test = useTestNotification();

  const [draft, setDraft] = useState<SyslogSettings>(saved);
  const [portText, setPortText] = useState(String(saved.port));
  const [facilityText, setFacilityText] = useState(String(saved.facility));

  const port = Number(portText);
  const facility = Number(facilityText);
  const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
  const facilityValid =
    Number.isInteger(facility) && facility >= FACILITY_MIN && facility <= FACILITY_MAX;
  const hostValid = !draft.enabled || draft.host.trim().length > 0;

  const next: SyslogSettings = {
    ...draft,
    port: portValid ? port : saved.port,
    facility: facilityValid ? facility : saved.facility,
  };
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);

  const protocolOptions = useMemo<readonly ComboboxOption<SyslogSettings['protocol']>[]>(
    () => SYSLOG_PROTOCOLS.map((value) => ({ value, label: value.toUpperCase() })),
    [],
  );

  const formatOptions = useMemo<readonly ComboboxOption<SyslogSettings['format']>[]>(
    () => SYSLOG_FORMATS.map((value) => ({ value, label: t(`settings.syslog.format.${value}`) })),
    [t],
  );

  const submit = () => {
    save.mutate(
      { activity: { syslog: next } },
      {
        onSuccess: () => toast.success(t('settings.syslog.saved')),
        onError: (error) => apiError.toastError(error, t('settings.syslog.failed')),
      },
    );
  };

  return (
    <SectionCard
      flush
      title={t('settings.syslog.title')}
      description={t('settings.syslog.description')}
      footer={
        <FormActions>
          <Button
            variant="outline"
            disabled={test.isPending || !saved.enabled}
            onClick={() =>
              test.mutate(
                { channel: 'syslog' },
                {
                  onSuccess: (result) => {
                    if (result.ok) {
                      toast.success(t('settings.syslog.testSent'), { description: result.detail });
                      return;
                    }
                    toast.error(t('settings.syslog.testFailed'), { description: result.detail });
                  },
                  onError: (error) => apiError.toastError(error, t('settings.syslog.testFailed')),
                },
              )
            }
          >
            {test.isPending ? <Spinner /> : null}
            {t('settings.syslog.sendTest')}
          </Button>
          <Button
            onClick={submit}
            disabled={!dirty || !hostValid || !portValid || !facilityValid || save.isPending}
          >
            {save.isPending ? <Spinner /> : null}
            {t('settings.saveChanges')}
          </Button>
        </FormActions>
      }
    >
      <FormRow label={t('settings.syslog.enabled')} hint={t('settings.syslog.enabledHint')}>
        <Switch
          checked={draft.enabled}
          onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
          aria-label={t('settings.syslog.enabled')}
        />
      </FormRow>

      <FormRow label={t('settings.syslog.collector')} hint={t('settings.syslog.collectorHint')}>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <Input
            value={draft.host}
            onChange={(event) => setDraft((current) => ({ ...current, host: event.target.value }))}
            className="font-mono"
            dir="ltr"
            placeholder="syslog.example.com"
            aria-label={t('settings.syslog.host')}
            aria-invalid={!hostValid}
          />
          <Input
            value={portText}
            onChange={(event) => setPortText(event.target.value)}
            inputMode="numeric"
            className="num"
            aria-label={t('settings.syslog.port')}
            aria-invalid={!portValid}
          />
        </div>
      </FormRow>

      <FormRow label={t('settings.syslog.protocol')} hint={t('settings.syslog.protocolHint')}>
        <Combobox
          options={protocolOptions}
          value={draft.protocol}
          onValueChange={(protocol) =>
            setDraft((current) => ({
              ...current,
              protocol: protocol ?? SETTINGS_DEFAULTS.activity.syslog.protocol,
            }))
          }
          className="sm:w-48"
          aria-label={t('settings.syslog.protocol')}
        />
      </FormRow>

      <FormRow label={t('settings.syslog.formatLabel')}>
        <Combobox
          options={formatOptions}
          value={draft.format}
          onValueChange={(format) =>
            setDraft((current) => ({
              ...current,
              format: format ?? SETTINGS_DEFAULTS.activity.syslog.format,
            }))
          }
          className="sm:w-48"
          aria-label={t('settings.syslog.formatLabel')}
        />
      </FormRow>

      <FormRow label={t('settings.syslog.facility')} hint={t('settings.syslog.facilityHint')}>
        <Input
          value={facilityText}
          onChange={(event) => setFacilityText(event.target.value)}
          inputMode="numeric"
          className="num sm:w-32"
          aria-label={t('settings.syslog.facility')}
          aria-invalid={!facilityValid}
        />
      </FormRow>
    </SectionCard>
  );
}
