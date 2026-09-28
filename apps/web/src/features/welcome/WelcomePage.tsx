import {
  CALENDARS,
  SIZE_UNITS,
  type Provider,
  type Server,
  type TestServerResponse,
} from '@storage-io/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  CheckIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  MonitorIcon,
  MoonIcon,
  RefreshCwIcon,
  ServerIcon,
  SparklesIcon,
  SunIcon,
} from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ChoiceCards,
  Combobox,
  FormField,
  Select,
  StepList,
  StepPanels,
  Tile,
  useStepper,
  type ChoiceOption,
  type ComboboxOption,
  type SelectOption,
  type StepDefinition,
} from '@/components/app';
import { ConnectionForm } from '@/features/servers/components/ConnectionForm';
import { ProviderPicker } from '@/features/servers/components/ProviderPicker';
import { ServerChecks } from '@/features/servers/components/ServerChecks';
import {
  applyConnectionFieldErrors,
  connectionFormSchema,
  emptyConnectionValues,
  toCreateServerRequest,
  type ConnectionFormValues,
} from '@/features/servers/connection-schema';
import { useCreateServer, useTestConnection } from '@/features/servers/api';
import { useSettings } from '@/features/shell/api';
import { useUpdateSettings } from '@/features/welcome/api';
import { useApiError } from '@/lib/api/useApiError';
import { LANGUAGES, usePreferences, type Language, type Theme } from '@/stores/preferences';

/**
 * First run: connect storage → verify → preferences → done.
 *
 * The admin account step the concept draws is gone by decision (the admin comes
 * from the environment) and so is 2FA, which is why this is four steps and not
 * five. Everything else is the concept's `setup.html`, and the connect and verify
 * steps are literally the same components the Add-server wizard uses.
 *
 * The server is created when the operator leaves the verify step, not at the end:
 * the "done" panel names the server and its bucket count, which only exists once
 * the API has actually stored it.
 */
export function WelcomePage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const apiError = useApiError();

  const form = useForm<ConnectionFormValues>({
    resolver: zodResolver(connectionFormSchema),
    mode: 'onBlur',
    defaultValues: emptyConnectionValues('minio'),
  });

  const test = useTestConnection();
  const create = useCreateServer();

  /** Both are the mutations' own state: the wizard keeps no copy of either. */
  const result: TestServerResponse | undefined = test.data;
  const testError = test.isError ? apiError.message(test.error) : undefined;
  const created: Server | undefined = create.data;

  const provider = form.watch('provider');
  const hasFailure = result !== undefined && result.checks.some((check) => check.status === 'fail');
  const verified = result !== undefined && !hasFailure;

  const steps = useMemo<readonly StepDefinition[]>(
    () => [
      // Deliberately not gated on `isValid`: a Continue that is disabled before the
      // operator has been told what is wrong is a dead click. It validates on press
      // and shows the errors instead.
      { id: 'connect', label: t('welcome.step.connect') },
      { id: 'verify', label: t('welcome.step.verify'), canContinue: verified },
      { id: 'preferences', label: t('welcome.step.preferences') },
      { id: 'done', label: t('welcome.step.done') },
    ],
    [t, verified],
  );

  const stepper = useStepper(steps);

  const runChecks = useCallback(() => {
    test.mutate(toCreateServerRequest(form.getValues()));
  }, [form, test]);

  const onContinue = useCallback(() => {
    if (stepper.current.id === 'connect') {
      void form.trigger().then((valid) => {
        if (!valid) return;
        stepper.next();
        runChecks();
      });
      return;
    }
    if (stepper.current.id === 'verify') {
      if (created !== undefined) {
        stepper.next();
        return;
      }
      create.mutate(toCreateServerRequest(form.getValues()), {
        onSuccess: () => stepper.next(),
        onError: (error) => {
          if (applyConnectionFieldErrors(error, form.setError)) {
            stepper.goTo(0);
            return;
          }
          apiError.toastError(error, t('servers.toast.addFailed'));
        },
      });
      return;
    }
    stepper.next();
  }, [apiError, create, created, form, runChecks, stepper, t]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <Badge variant="secondary">
          <SparklesIcon />
          {t('welcome.badge')}
        </Badge>
        <h1 className="text-(length:--h1) font-semibold tracking-[-0.02em]">
          {t('welcome.title')}
        </h1>
        <p className="text-muted-foreground">{t('welcome.description')}</p>
      </div>

      <StepList stepper={stepper} className="justify-center" />

      <Card className="gap-0 overflow-hidden py-0">
        <StepPanels
          stepper={stepper}
          panels={{
            connect: (
              <>
                <PanelHeader
                  title={t('welcome.connect.title')}
                  description={t('welcome.connect.description')}
                />
                <CardContent className="flex flex-col gap-4 p-(--card-pad)">
                  <ProviderPicker
                    value={provider}
                    onValueChange={(next: Provider) =>
                      form.reset({
                        ...emptyConnectionValues(next),
                        name: form.getValues('name'),
                      })
                    }
                  />
                  <ConnectionForm form={form} mode="create" />
                </CardContent>
              </>
            ),
            verify: (
              <>
                <PanelHeader
                  title={t('welcome.verify.title')}
                  description={
                    <span className="ltr-isolate font-mono">{form.watch('endpoint')}</span>
                  }
                  action={
                    <Button variant="ghost" size="sm" onClick={runChecks} disabled={test.isPending}>
                      <RefreshCwIcon />
                      {t('servers.wizard.runAgain')}
                    </Button>
                  }
                />
                <CardContent className="p-(--card-pad)">
                  <ServerChecks
                    checks={result?.checks}
                    running={test.isPending}
                    error={testError}
                    capabilities={result?.capabilities}
                    version={result?.version}
                    bucketCount={result?.bucketCount}
                  />
                </CardContent>
              </>
            ),
            preferences: (
              <>
                <PanelHeader
                  title={t('welcome.preferences.title')}
                  description={t('welcome.preferences.description')}
                />
                <CardContent className="p-(--card-pad)">
                  <PreferencesPanel />
                </CardContent>
              </>
            ),
            done: (
              <CardContent className="flex flex-col items-center gap-5 p-(--card-pad) py-10">
                <span className="grid size-14 place-items-center rounded-full bg-success/15 text-success">
                  <CheckIcon className="size-7" aria-hidden="true" />
                </span>
                <div className="flex flex-col items-center gap-1 text-center">
                  <h2 className="text-lg font-semibold">{t('welcome.done.title')}</h2>
                  <p className="max-w-lg text-sm text-muted-foreground">
                    {created === undefined
                      ? t('welcome.done.generic')
                      : t('welcome.done.body', {
                          name: created.name,
                          count: created.counts.buckets,
                        })}
                  </p>
                </div>
                <div className="grid w-full gap-2.5 sm:grid-cols-3">
                  <Tile
                    icon={ServerIcon}
                    label={t('welcome.done.addAnother')}
                    asChild={(content, className) => (
                      <Link to="/servers/new" className={className}>
                        {content}
                      </Link>
                    )}
                  />
                  <Tile
                    icon={FolderOpenIcon}
                    label={t('welcome.done.browse')}
                    asChild={(content, className) => (
                      <Link to="/browse" className={className}>
                        {content}
                      </Link>
                    )}
                  />
                  <Tile
                    icon={KeyRoundIcon}
                    label={t('welcome.done.createKey')}
                    asChild={(content, className) => (
                      <Link to="/keys/new" className={className}>
                        {content}
                      </Link>
                    )}
                  />
                </div>
              </CardContent>
            ),
          }}
        />

        <div className="flex items-center gap-2 border-t p-(--card-pad)">
          <Button
            type="button"
            variant="ghost"
            onClick={stepper.back}
            disabled={stepper.isFirst || create.isPending}
          >
            {tCommon('action.back')}
          </Button>
          <span className="ms-auto" />
          {stepper.isLast ? (
            <Button type="button" onClick={() => void navigate({ to: '/' })}>
              {t('welcome.openOverview')}
              <ArrowRightIcon className="flip-rtl" />
            </Button>
          ) : (
            <Button
              type="button"
              onClick={onContinue}
              disabled={!stepper.canContinue || create.isPending || test.isPending}
            >
              {t('welcome.continue')}
              <ArrowRightIcon className="flip-rtl" />
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

function PanelHeader({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: React.ReactNode;
  readonly action?: React.ReactNode;
}) {
  return (
    <CardHeader className="flex-row items-start gap-3 border-b px-(--card-pad) py-(--card-pad) [.border-b]:pb-(--card-pad)">
      <div className="min-w-0 flex-1">
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription className="mt-0.5 text-xs">{description}</CardDescription>
      </div>
      {action}
    </CardHeader>
  );
}

/**
 * Language and theme are per-browser preferences (zustand + localStorage); units,
 * calendar and timezone belong to the installation and go to `PATCH /settings`.
 * Each control saves on change rather than on a Save button, because this panel's
 * effect is visible immediately in the page around it.
 */
function PreferencesPanel() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const language = usePreferences((state) => state.language);
  const setLanguage = usePreferences((state) => state.setLanguage);
  const theme = usePreferences((state) => state.theme);
  const setTheme = usePreferences((state) => state.setTheme);

  const region = settings.data?.region;

  const patchRegion = useCallback(
    (next: Partial<NonNullable<typeof region>>) => {
      updateSettings.mutate(
        { region: next },
        { onError: (error) => apiError.toastError(error) },
      );
    },
    [apiError, updateSettings],
  );

  const languageOptions = useMemo<readonly SelectOption<Language>[]>(
    () => LANGUAGES.map((code) => ({ value: code, label: tCommon(`language.${code}`) })),
    [tCommon],
  );

  const unitOptions = useMemo<readonly SelectOption<(typeof SIZE_UNITS)[number]>[]>(
    () => SIZE_UNITS.map((unit) => ({ value: unit, label: t(`welcome.preferences.units.${unit}`) })),
    [t],
  );

  const calendarOptions = useMemo<readonly SelectOption<(typeof CALENDARS)[number]>[]>(
    () =>
      CALENDARS.map((calendar) => ({
        value: calendar,
        label: t(`welcome.preferences.calendars.${calendar}`),
      })),
    [t],
  );

  /**
   * `Intl.supportedValuesOf('timeZone')` lists the IANA zones but not `UTC`, which
   * is exactly the settings default — so the current value is always folded in, or
   * the picker would show a placeholder for a timezone that is actually set.
   */
  const timezoneOptions = useMemo<readonly ComboboxOption<string>[]>(() => {
    const zones = new Set<string>(['UTC', ...Intl.supportedValuesOf('timeZone')]);
    if (region !== undefined) zones.add(region.timezone);
    return [...zones].map((zone) => ({ value: zone, label: zone }));
  }, [region]);

  const themeOptions = useMemo<readonly ChoiceOption<Theme>[]>(
    () => [
      { value: 'light', label: tCommon('theme.light'), media: <SunIcon className="size-4" /> },
      { value: 'dark', label: tCommon('theme.dark'), media: <MoonIcon className="size-4" /> },
      {
        value: 'system',
        label: tCommon('theme.system'),
        media: <MonitorIcon className="size-4" />,
      },
    ],
    [tCommon],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={tCommon('language.label')}>
          {({ id }) => (
            <Select
              id={id}
              options={languageOptions}
              value={language}
              onValueChange={setLanguage}
              aria-label={tCommon('language.label')}
            />
          )}
        </FormField>

        <FormField
          label={t('welcome.preferences.sizeUnits')}
          // The hint describes the option that is actually selected: a line about
          // decimal under a binary selection is worse than no line at all.
          hint={
            (region?.sizeUnits ?? 'decimal') === 'binary'
              ? t('welcome.preferences.sizeUnitsHintBinary')
              : t('welcome.preferences.sizeUnitsHintDecimal')
          }
        >
          {({ id }) => (
            <Select
              id={id}
              options={unitOptions}
              value={region?.sizeUnits ?? 'decimal'}
              onValueChange={(sizeUnits) => patchRegion({ sizeUnits })}
              disabled={region === undefined}
              aria-label={t('welcome.preferences.sizeUnits')}
            />
          )}
        </FormField>

        <FormField label={t('welcome.preferences.calendar')}>
          {({ id }) => (
            <Select
              id={id}
              options={calendarOptions}
              value={region?.calendar ?? 'auto'}
              onValueChange={(calendar) => patchRegion({ calendar })}
              disabled={region === undefined}
              aria-label={t('welcome.preferences.calendar')}
            />
          )}
        </FormField>

        <FormField label={t('welcome.preferences.timezone')}>
          {({ id }) => (
            <Combobox
              id={id}
              options={timezoneOptions}
              value={region?.timezone ?? null}
              onValueChange={(timezone) => {
                if (timezone !== null) patchRegion({ timezone });
              }}
              disabled={region === undefined}
              aria-label={t('welcome.preferences.timezone')}
            />
          )}
        </FormField>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium">{tCommon('theme.label')}</span>
        <ChoiceCards
          options={themeOptions}
          value={theme}
          onValueChange={setTheme}
          columns={3}
          aria-label={tCommon('theme.label')}
        />
      </div>
    </div>
  );
}
