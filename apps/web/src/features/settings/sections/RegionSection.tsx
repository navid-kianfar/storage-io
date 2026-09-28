import {
  CALENDARS,
  DIGIT_MODES,
  SETTINGS_DEFAULTS,
  SIZE_UNITS,
  WEEK_STARTS,
  type RegionSettings,
  type Settings,
} from '@storage-io/contracts';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Bytes,
  Button,
  Combobox,
  DateTime,
  FormActions,
  FormRow,
  SectionCard,
  SegmentedControl,
  Skeleton,
  Spinner,
  type ComboboxOption,
  type SegmentedOption,
} from '@/components/app';
import { useUpdateSettings } from '@/features/settings/api';
import { useApiError } from '@/lib/api/useApiError';
import { LANGUAGES, usePreferences, type Language } from '@/stores/preferences';

/**
 * Language is per browser; everything else here is the installation's, because a
 * size in a CSV export or a timestamp in a syslog line has to be the same whoever
 * is looking.
 *
 * Every hint is a *live* example rendered through the same formatter the rest of
 * the app uses — the byte hint under "Size units" changes as the control changes,
 * so the operator sees the consequence before saving rather than after.
 */

const EXAMPLE_BYTES = 3.2e12;

/** The timezones offered by name; any IANA zone the browser knows is accepted. */
function timezoneOptions(): readonly string[] {
  const supported = Intl.supportedValuesOf;
  const zones = typeof supported === 'function' ? supported('timeZone') : [];
  return zones.length > 0 ? zones : ['UTC'];
}

export function RegionSection({
  settings,
  loading,
}: {
  readonly settings: Settings | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');

  if (loading || settings === undefined) {
    return (
      <SectionCard title={t('settings.region.title')} description={t('settings.region.description')}>
        <Skeleton className="h-40 w-full" />
      </SectionCard>
    );
  }

  return <RegionForm key={JSON.stringify(settings.region)} saved={settings.region} />;
}

function RegionForm({ saved }: { readonly saved: RegionSettings }) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const save = useUpdateSettings();

  const language = usePreferences((state) => state.language);
  const setLanguage = usePreferences((state) => state.setLanguage);

  const [draft, setDraft] = useState<RegionSettings>(saved);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const patch = (next: Partial<RegionSettings>) =>
    setDraft((current) => ({ ...current, ...next }));

  const languageOptions = useMemo<readonly ComboboxOption<Language>[]>(
    () => LANGUAGES.map((value) => ({ value, label: tCommon(`language.${value}`) })),
    [tCommon],
  );

  const digitOptions = useMemo<readonly ComboboxOption<RegionSettings['digits']>[]>(
    () => DIGIT_MODES.map((value) => ({ value, label: t(`settings.region.digits.${value}`) })),
    [t],
  );

  const calendarOptions = useMemo<readonly ComboboxOption<RegionSettings['calendar']>[]>(
    () => CALENDARS.map((value) => ({ value, label: t(`settings.region.calendar.${value}`) })),
    [t],
  );

  const unitOptions = useMemo<readonly SegmentedOption<RegionSettings['sizeUnits']>[]>(
    () => SIZE_UNITS.map((value) => ({ value, label: t(`settings.region.units.${value}`) })),
    [t],
  );

  // The stored zone is always in the list: `Intl.supportedValuesOf` omits some
  // aliases (and the whole API is missing on older engines), and a control that
  // cannot show the current value is a control that quietly changes it on save.
  const zoneOptions = useMemo<readonly ComboboxOption<string>[]>(() => {
    const zones = new Set<string>(['UTC', draft.timezone, ...timezoneOptions()]);
    return [...zones].sort().map((zone) => ({ value: zone, label: zone }));
  }, [draft.timezone]);

  const weekStartOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      WEEK_STARTS.map((value) => ({
        value: String(value),
        label: t(`settings.region.weekStart.${String(value)}`),
      })),
    [t],
  );

  const submit = () => {
    save.mutate(
      { region: draft },
      {
        onSuccess: () => toast.success(t('settings.region.saved')),
        onError: (error) => apiError.toastError(error, t('settings.region.failed')),
      },
    );
  };

  return (
    <SectionCard
      flush
      title={t('settings.region.title')}
      description={t('settings.region.description')}
      footer={
        <FormActions>
          <Button variant="outline" disabled={!dirty} onClick={() => setDraft(saved)}>
            {tCommon('action.cancel')}
          </Button>
          <Button onClick={submit} disabled={!dirty || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            {t('settings.saveChanges')}
          </Button>
        </FormActions>
      }
    >
      <FormRow label={tCommon('language.label')} hint={t('settings.region.languageHint')}>
        <Combobox
          options={languageOptions}
          value={language}
          onValueChange={(value) => {
            if (value === null) return;
            setLanguage(value);
          }}
          className="sm:w-64"
          aria-label={tCommon('language.label')}
        />
      </FormRow>

      <FormRow label={t('settings.region.digitsLabel')} hint="۱۲۳ / ١٢٣ / 123">
        <Combobox
          options={digitOptions}
          value={draft.digits}
          onValueChange={(value) => patch({ digits: value ?? 'auto' })}
          className="sm:w-64"
          aria-label={t('settings.region.digitsLabel')}
        />
      </FormRow>

      <FormRow
        label={t('settings.region.calendarLabel')}
        hint={
          <>
            {t('settings.region.today')}: <DateTime value={new Date().toISOString()} style="date" />
          </>
        }
      >
        <Combobox
          options={calendarOptions}
          value={draft.calendar}
          onValueChange={(value) => patch({ calendar: value ?? 'auto' })}
          className="sm:w-64"
          aria-label={t('settings.region.calendarLabel')}
        />
      </FormRow>

      <FormRow
        label={t('settings.region.sizeUnits')}
        hint={
          <span className="num">
            <Bytes value={EXAMPLE_BYTES} />
          </span>
        }
      >
        <SegmentedControl
          options={unitOptions}
          value={draft.sizeUnits}
          onValueChange={(value) => patch({ sizeUnits: value })}
          aria-label={t('settings.region.sizeUnits')}
        />
      </FormRow>

      <FormRow label={t('settings.region.timezone')} hint={t('settings.region.timezoneHint')}>
        <Combobox
          options={zoneOptions}
          value={draft.timezone}
          onValueChange={(value) => patch({ timezone: value ?? SETTINGS_DEFAULTS.region.timezone })}
          className="sm:w-80"
          aria-label={t('settings.region.timezone')}
        />
      </FormRow>

      <FormRow label={t('settings.region.weekStartLabel')}>
        <Combobox
          options={weekStartOptions}
          value={String(draft.weekStart)}
          onValueChange={(value) => {
            if (value === null) return;
            patch({ weekStart: value === 'auto' ? 'auto' : (Number(value) as 0 | 1 | 6) });
          }}
          className="sm:w-64"
          aria-label={t('settings.region.weekStartLabel')}
        />
      </FormRow>
    </SectionCard>
  );
}
