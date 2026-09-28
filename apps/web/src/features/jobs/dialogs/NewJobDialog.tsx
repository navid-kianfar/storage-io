import {
  JOB_CONCURRENCY_MAX,
  JOB_CONCURRENCY_MIN,
  JOB_FILTER_DEFAULTS,
  OBJECT_LOCK_MODES,
  type ConflictStrategy,
  type CreateJobRequest,
  type EstimateJobResponse,
  type JobFilters,
  type JobType,
  type ObjectLockMode,
} from '@storage-io/contracts';
import {
  CalendarClockIcon,
  FolderInputIcon,
  FolderOpenIcon,
  InfoIcon,
  PlayIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  ByteSizeInput,
  Bytes,
  Button,
  Checkbox,
  ChoiceCards,
  Combobox,
  DatePicker,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Num,
  OptionRow,
  SectionCard,
  SegmentedControl,
  Slider,
  StepList,
  StepPanels,
  StepperNav,
  Switch,
  TagEditor,
  useStepper,
  type ChoiceOption,
  type ComboboxOption,
  type SegmentedOption,
  type StepDefinition,
} from '@/components/app';
import { useBuckets } from '@/features/buckets/api';
import { useCreateJob, useEstimateJob } from '@/features/jobs/api';
import { CronText } from '@/features/jobs/components/CronText';
import { CRON_PRESETS, isCronExpression } from '@/features/jobs/cron';
import {
  WIZARD_JOB_TYPES,
  jobHasTarget,
  jobIsDestructive,
  JOB_TYPE_ICONS,
} from '@/features/jobs/jobTypes';
import { useServers } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { registerDialog, type DialogProps } from '@/lib/dialogs/registry';

/**
 * The four-step New bulk job wizard: `?dialog=new-job`.
 *
 * It accepts a prefill, which is the whole reason it is URL-addressable: the object
 * browser's "Run selection as bulk job…" opens
 * `?dialog=new-job&d_server=…&d_bucket=…&d_prefix=…&d_type=copy`, and the operator
 * lands on step 2 with the scope already filled in rather than re-picking a bucket
 * they were just looking at. `d_keys` (a comma-separated selection) narrows the
 * source to a glob over those keys, because the contract's job source is a prefix
 * plus filters — there is no key list on it, so the honest translation of a
 * selection is a filter, and the review step says so.
 *
 * Two things are deliberate. First, the estimate is a *request*, not a guess: the
 * server lists the prefix, time-boxed, and `partial` is shown when it gave up — a
 * made-up object count would decide an operator's evening. Second, a destructive
 * operation arrives with the dry run already on and cannot be started from the
 * review step until the operator has acknowledged what it will do.
 */

const STEP_IDS = ['operation', 'scope', 'options', 'review'] as const;
const PICKER_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 8;
const SLIDER_STEP = 1;

interface WizardState {
  readonly type: JobType;
  readonly name: string;
  readonly sourceServerId: string | null;
  readonly sourceBucket: string | null;
  readonly prefix: string;
  readonly modifiedAfter: Date | null;
  readonly modifiedBefore: Date | null;
  readonly minSize: number | null;
  readonly maxSize: number | null;
  readonly glob: string;
  readonly tagFilters: Readonly<Record<string, string>>;
  readonly targetServerId: string | null;
  readonly targetBucket: string | null;
  readonly targetPrefix: string;
  readonly conflict: ConflictStrategy;
  readonly concurrency: number;
  readonly dryRun: boolean;
  readonly scheduleKind: 'now' | 'at' | 'cron';
  readonly runAt: Date | null;
  readonly cron: string;
  readonly newTags: Readonly<Record<string, string>>;
  readonly storageClass: string;
  readonly retentionMode: ObjectLockMode;
  readonly retentionDays: string;
  readonly includeVersions: boolean;
  readonly acknowledged: boolean;
}

function initialState(params: Readonly<Record<string, string>>): WizardState {
  const prefilledType = params.type;
  const type: JobType =
    prefilledType !== undefined && (WIZARD_JOB_TYPES as readonly string[]).includes(prefilledType)
      ? (prefilledType as JobType)
      : 'copy';
  const keys = (params.keys ?? '').split(',').filter((key) => key.length > 0);
  return {
    type,
    name: '',
    sourceServerId: params.server ?? null,
    sourceBucket: params.bucket ?? null,
    prefix: params.prefix ?? '',
    modifiedAfter: null,
    modifiedBefore: null,
    minSize: null,
    maxSize: null,
    // A selection of keys becomes a glob that matches exactly those names, which is
    // the only shape the contract's JobFilters can express.
    glob: keys.length === 1 ? (keys[0] ?? '') : keys.length > 1 ? `{${keys.join(',')}}` : '',
    tagFilters: {},
    targetServerId: null,
    targetBucket: null,
    targetPrefix: '',
    conflict: 'skip',
    concurrency: DEFAULT_CONCURRENCY,
    dryRun: jobIsDestructive(type),
    scheduleKind: 'now',
    runAt: null,
    cron: '0 3 * * *',
    newTags: {},
    storageClass: '',
    retentionMode: 'GOVERNANCE',
    retentionDays: '30',
    includeVersions: false,
    acknowledged: false,
  };
}

export function NewJobDialog({ params, onClose }: DialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomain } = useTranslation('domain');
  const apiError = useApiError();

  const [state, setState] = useState<WizardState>(() => initialState(params));
  const patch = useCallback(
    (next: Partial<WizardState>) => setState((current) => ({ ...current, ...next })),
    [],
  );

  const servers = useServers();
  const buckets = useBuckets({ sort: 'name', page: 1, pageSize: PICKER_PAGE_SIZE });
  const estimate = useEstimateJob();
  const createJob = useCreateJob();

  const serverOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      (servers.data?.items ?? [])
        .filter((server) => server.capabilities.objects === 'supported')
        .map((server) => ({
          value: server.id,
          label: server.name,
          description: server.endpoint,
          disabled: server.status === 'offline',
        })),
    [servers.data],
  );

  const bucketOptionsFor = useCallback(
    (serverId: string | null): readonly ComboboxOption<string>[] =>
      (buckets.data?.items ?? [])
        .filter((bucket) => serverId !== null && bucket.serverId === serverId)
        .map((bucket) => ({
          value: bucket.name,
          label: bucket.name,
          description: bucket.serverName,
          disabled: bucket.unavailable,
        })),
    [buckets.data],
  );

  const filters = useMemo<JobFilters>(
    () => ({
      ...JOB_FILTER_DEFAULTS,
      prefix: state.prefix,
      modifiedAfter: state.modifiedAfter?.toISOString() ?? null,
      modifiedBefore: state.modifiedBefore?.toISOString() ?? null,
      minSize: state.minSize,
      maxSize: state.maxSize,
      glob: state.glob.length > 0 ? state.glob : null,
      tags: state.tagFilters,
    }),
    [state],
  );

  const needsTarget = jobHasTarget(state.type);
  const scopeReady = state.sourceServerId !== null && state.sourceBucket !== null;
  const cronValid = isCronExpression(state.cron);
  const retentionDaysValue = Number(state.retentionDays);
  const retentionValid =
    state.type !== 'retention' ||
    (Number.isInteger(retentionDaysValue) && retentionDaysValue >= 1);
  const optionsReady =
    (!needsTarget || (state.targetServerId !== null && state.targetBucket !== null)) &&
    (state.scheduleKind !== 'at' || state.runAt !== null) &&
    (state.scheduleKind !== 'cron' || cronValid) &&
    (state.type !== 'tag' || Object.keys(state.newTags).length > 0) &&
    (state.type !== 'storage-class' || state.storageClass.trim().length > 0) &&
    retentionValid;
  const reviewReady = !jobIsDestructive(state.type) || state.acknowledged;

  const steps = useMemo<readonly StepDefinition[]>(
    () => [
      { id: STEP_IDS[0], label: t('jobs.wizard.step.operation'), canContinue: true },
      { id: STEP_IDS[1], label: t('jobs.wizard.step.scope'), canContinue: scopeReady },
      { id: STEP_IDS[2], label: t('jobs.wizard.step.options'), canContinue: optionsReady },
      { id: STEP_IDS[3], label: t('jobs.wizard.step.review'), canContinue: reviewReady },
    ],
    [optionsReady, reviewReady, scopeReady, t],
  );
  const stepper = useStepper(steps);

  const runEstimate = useCallback(() => {
    if (state.sourceServerId === null || state.sourceBucket === null) return;
    estimate.mutate(
      { source: { serverId: state.sourceServerId, bucket: state.sourceBucket, filters } },
      { onError: (error) => apiError.toastError(error, t('jobs.wizard.estimateFailed')) },
    );
  }, [apiError, estimate, filters, state.sourceBucket, state.sourceServerId, t]);

  const typeOptions = useMemo<readonly ChoiceOption<JobType>[]>(
    () =>
      WIZARD_JOB_TYPES.map((type) => {
        const Icon = JOB_TYPE_ICONS[type];
        return {
          value: type,
          label: tDomain(`jobType.${type}`),
          description: t(`jobs.wizard.typeHint.${type}`),
          media: <Icon className="size-4 text-primary" aria-hidden="true" />,
        };
      }),
    [t, tDomain],
  );

  const conflictOptions = useMemo<readonly ChoiceOption<ConflictStrategy>[]>(
    () => [
      {
        value: 'skip',
        label: t('jobs.wizard.conflict.skip'),
        description: t('jobs.wizard.conflict.skipHint'),
      },
      {
        value: 'overwrite',
        label: t('jobs.wizard.conflict.overwrite'),
        description: t('jobs.wizard.conflict.overwriteHint'),
      },
      {
        value: 'rename',
        label: t('jobs.wizard.conflict.rename'),
        description: t('jobs.wizard.conflict.renameHint'),
      },
    ],
    [t],
  );

  const scheduleOptions = useMemo<readonly SegmentedOption<'now' | 'at' | 'cron'>[]>(
    () => [
      { value: 'now', label: t('jobs.wizard.schedule.now') },
      { value: 'at', label: t('jobs.wizard.schedule.at') },
      { value: 'cron', label: t('jobs.wizard.schedule.cron') },
    ],
    [t],
  );

  const submit = useCallback(() => {
    if (state.sourceServerId === null || state.sourceBucket === null) return;

    const body: CreateJobRequest = {
      type: state.type,
      source: { serverId: state.sourceServerId, bucket: state.sourceBucket, filters },
      params: {
        ...(state.type === 'tag' ? { tags: state.newTags } : {}),
        ...(state.type === 'storage-class' ? { storageClass: state.storageClass.trim() } : {}),
        ...(state.type === 'retention'
          ? { retention: { mode: state.retentionMode, days: retentionDaysValue } }
          : {}),
        ...(state.type === 'delete' || state.type === 'restore-versions'
          ? { includeVersions: state.includeVersions }
          : {}),
      },
      options: {
        conflict: state.conflict,
        concurrency: state.concurrency,
        dryRun: state.dryRun,
      },
      schedule:
        state.scheduleKind === 'now'
          ? { kind: 'now' }
          : state.scheduleKind === 'at'
            ? { kind: 'at', at: (state.runAt ?? new Date()).toISOString() }
            : { kind: 'cron', cron: state.cron, timezone: currentTimezone(), enabled: true },
      // The field's placeholder is the operation's own label, so a blank name is
      // saved as exactly what the operator was shown rather than as the raw enum.
      name: state.name.trim().length > 0 ? state.name.trim() : tDomain(`jobType.${state.type}`),
      ...(needsTarget && state.targetServerId !== null && state.targetBucket !== null
        ? {
            target: {
              serverId: state.targetServerId,
              bucket: state.targetBucket,
              prefix: state.targetPrefix,
            },
          }
        : {}),
    };

    createJob.mutate(body, {
      onSuccess: (job) => {
        toast.success(
          state.scheduleKind === 'now' ? t('jobs.toast.started') : t('jobs.toast.scheduled'),
          { description: job.name },
        );
        onClose();
      },
      onError: (error) => apiError.toastError(error, t('jobs.toast.startFailed')),
    });
  }, [
    apiError,
    createJob,
    filters,
    needsTarget,
    onClose,
    retentionDaysValue,
    state,
    t,
    tDomain,
  ]);

  const estimateResult = estimate.data;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] gap-0 overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('jobs.wizard.title')}</DialogTitle>
          <DialogDescription>{t('jobs.wizard.description')}</DialogDescription>
        </DialogHeader>

        <StepList stepper={stepper} className="mt-2" />

        <StepPanels
          stepper={stepper}
          panels={{
            operation: (
              <div className="flex flex-col gap-4 py-4">
                <ChoiceCards
                  options={typeOptions}
                  value={state.type}
                  onValueChange={(type) =>
                    patch({ type, dryRun: jobIsDestructive(type), acknowledged: false })
                  }
                  orientation="grid"
                  columns={3}
                  aria-label={t('jobs.wizard.step.operation')}
                />
                <FormField label={t('jobs.wizard.name')} optionalText={` (${tCommon('form.optional')})`}>
                  {({ id }) => (
                    <Input
                      id={id}
                      value={state.name}
                      onChange={(event) => patch({ name: event.target.value })}
                      placeholder={tDomain(`jobType.${state.type}`)}
                    />
                  )}
                </FormField>
                {jobIsDestructive(state.type) ? (
                  <Alert variant="info">
                    <InfoIcon />
                    <AlertDescription>{t('jobs.wizard.destructiveNote')}</AlertDescription>
                  </Alert>
                ) : null}
              </div>
            ),

            scope: (
              <div className="flex flex-col gap-4 py-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label={t('jobs.wizard.sourceServer')}>
                    {({ id }) => (
                      <Combobox
                        id={id}
                        options={serverOptions}
                        value={state.sourceServerId}
                        onValueChange={(sourceServerId) =>
                          patch({ sourceServerId, sourceBucket: null })
                        }
                        placeholder={t('jobs.wizard.pickServer')}
                        aria-label={t('jobs.wizard.sourceServer')}
                      />
                    )}
                  </FormField>
                  <FormField label={t('jobs.wizard.sourceBucket')}>
                    {({ id }) => (
                      <Combobox
                        id={id}
                        options={bucketOptionsFor(state.sourceServerId)}
                        value={state.sourceBucket}
                        onValueChange={(sourceBucket) => patch({ sourceBucket })}
                        placeholder={t('jobs.wizard.pickBucket')}
                        disabled={state.sourceServerId === null}
                        aria-label={t('jobs.wizard.sourceBucket')}
                      />
                    )}
                  </FormField>
                </div>

                <FormField label={t('jobs.wizard.prefix')} hint={t('jobs.wizard.prefixHint')}>
                  {({ id }) => (
                    <InputGroup>
                      <InputGroupAddon>
                        <FolderOpenIcon />
                      </InputGroupAddon>
                      <InputGroupInput
                        id={id}
                        value={state.prefix}
                        onChange={(event) => patch({ prefix: event.target.value })}
                        className="font-mono"
                        dir="ltr"
                        placeholder="raw/2026/"
                      />
                    </InputGroup>
                  )}
                </FormField>

                <SectionCard
                  title={t('jobs.wizard.filters')}
                  description={t('jobs.wizard.filtersHint')}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label={t('jobs.wizard.modifiedAfter')}>
                      {({ id }) => (
                        <DatePicker
                          id={id}
                          value={state.modifiedAfter}
                          onValueChange={(modifiedAfter) => patch({ modifiedAfter })}
                          clearable
                          aria-label={t('jobs.wizard.modifiedAfter')}
                        />
                      )}
                    </FormField>
                    <FormField label={t('jobs.wizard.modifiedBefore')}>
                      {({ id }) => (
                        <DatePicker
                          id={id}
                          value={state.modifiedBefore}
                          onValueChange={(modifiedBefore) => patch({ modifiedBefore })}
                          clearable
                          aria-label={t('jobs.wizard.modifiedBefore')}
                        />
                      )}
                    </FormField>
                    <FormField label={t('jobs.wizard.minSize')}>
                      {({ id }) => (
                        <ByteSizeInput
                          id={id}
                          value={state.minSize}
                          onValueChange={(minSize) => patch({ minSize })}
                          aria-label={t('jobs.wizard.minSize')}
                        />
                      )}
                    </FormField>
                    <FormField label={t('jobs.wizard.maxSize')}>
                      {({ id }) => (
                        <ByteSizeInput
                          id={id}
                          value={state.maxSize}
                          onValueChange={(maxSize) => patch({ maxSize })}
                          aria-label={t('jobs.wizard.maxSize')}
                        />
                      )}
                    </FormField>
                    <FormField label={t('jobs.wizard.glob')} hint={t('jobs.wizard.globHint')}>
                      {({ id }) => (
                        <Input
                          id={id}
                          value={state.glob}
                          onChange={(event) => patch({ glob: event.target.value })}
                          className="font-mono"
                          dir="ltr"
                          placeholder="*.log"
                        />
                      )}
                    </FormField>
                    <FormField label={t('jobs.wizard.tagFilters')}>
                      {() => (
                        <TagEditor
                          tags={state.tagFilters}
                          onTagsChange={(tagFilters) => patch({ tagFilters })}
                          hint={t('jobs.wizard.tagFiltersHint')}
                        />
                      )}
                    </FormField>
                  </div>
                </SectionCard>

                <Alert variant="info">
                  <InfoIcon />
                  <AlertTitle>{t('jobs.wizard.estimatedScope')}</AlertTitle>
                  <AlertDescription className="block">
                    {estimateResult === undefined ? (
                      t('jobs.wizard.noEstimate')
                    ) : (
                      <EstimateLine result={estimateResult} partialLabel={t('jobs.wizard.partial')} />
                    )}
                  </AlertDescription>
                  <div className="col-start-2 mt-2 sm:absolute sm:end-4 sm:top-1/2 sm:col-start-auto sm:mt-0 sm:-translate-y-1/2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={runEstimate}
                      disabled={!scopeReady || estimate.isPending}
                    >
                      <RefreshCwIcon />
                      {t('jobs.wizard.recount')}
                    </Button>
                  </div>
                </Alert>
              </div>
            ),

            options: (
              <div className="flex flex-col gap-4 py-4">
                {needsTarget ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label={t('jobs.wizard.targetServer')}>
                      {({ id }) => (
                        <Combobox
                          id={id}
                          options={serverOptions}
                          value={state.targetServerId}
                          onValueChange={(targetServerId) =>
                            patch({ targetServerId, targetBucket: null })
                          }
                          placeholder={t('jobs.wizard.pickServer')}
                          aria-label={t('jobs.wizard.targetServer')}
                        />
                      )}
                    </FormField>
                    <FormField label={t('jobs.wizard.targetBucket')}>
                      {({ id }) => (
                        <Combobox
                          id={id}
                          options={bucketOptionsFor(state.targetServerId)}
                          value={state.targetBucket}
                          onValueChange={(targetBucket) => patch({ targetBucket })}
                          placeholder={t('jobs.wizard.pickBucket')}
                          disabled={state.targetServerId === null}
                          aria-label={t('jobs.wizard.targetBucket')}
                        />
                      )}
                    </FormField>
                    <FormField
                      label={t('jobs.wizard.targetPrefix')}
                      className="sm:col-span-2"
                      hint={t('jobs.wizard.targetPrefixHint')}
                    >
                      {({ id }) => (
                        <InputGroup>
                          <InputGroupAddon>
                            <FolderInputIcon />
                          </InputGroupAddon>
                          <InputGroupInput
                            id={id}
                            value={state.targetPrefix}
                            onChange={(event) => patch({ targetPrefix: event.target.value })}
                            className="font-mono"
                            dir="ltr"
                          />
                        </InputGroup>
                      )}
                    </FormField>
                  </div>
                ) : null}

                {state.type === 'tag' ? (
                  <FormField label={t('jobs.wizard.tagsToApply')}>
                    {() => (
                      <TagEditor
                        tags={state.newTags}
                        onTagsChange={(newTags) => patch({ newTags })}
                        hint={t('jobs.wizard.tagsToApplyHint')}
                      />
                    )}
                  </FormField>
                ) : null}

                {state.type === 'storage-class' ? (
                  <FormField
                    label={t('jobs.wizard.storageClass')}
                    hint={t('jobs.wizard.storageClassHint')}
                  >
                    {({ id }) => (
                      <Input
                        id={id}
                        value={state.storageClass}
                        onChange={(event) => patch({ storageClass: event.target.value })}
                        className="font-mono"
                        dir="ltr"
                        placeholder="GLACIER"
                      />
                    )}
                  </FormField>
                ) : null}

                {state.type === 'retention' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label={t('jobs.wizard.retentionMode')}>
                      {({ id }) => (
                        <Combobox
                          id={id}
                          options={OBJECT_LOCK_MODES.map((mode) => ({
                            value: mode,
                            label: t(`jobs.wizard.retention.${mode}`),
                          }))}
                          value={state.retentionMode}
                          onValueChange={(mode) =>
                            patch({ retentionMode: mode ?? 'GOVERNANCE' })
                          }
                          aria-label={t('jobs.wizard.retentionMode')}
                        />
                      )}
                    </FormField>
                    <FormField
                      label={t('jobs.wizard.retentionDays')}
                      error={retentionValid ? undefined : tCommon('form.invalid')}
                    >
                      {({ id, invalid }) => (
                        <Input
                          id={id}
                          value={state.retentionDays}
                          onChange={(event) => patch({ retentionDays: event.target.value })}
                          inputMode="numeric"
                          aria-invalid={invalid}
                          className="num"
                        />
                      )}
                    </FormField>
                  </div>
                ) : null}

                {needsTarget ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[0.8125rem] font-medium">
                      {t('jobs.wizard.onConflict')}
                    </span>
                    <ChoiceCards
                      options={conflictOptions}
                      value={state.conflict}
                      onValueChange={(conflict) => patch({ conflict })}
                      orientation="grid"
                      columns={3}
                      aria-label={t('jobs.wizard.onConflict')}
                    />
                  </div>
                ) : null}

                <FormField
                  label={t('jobs.wizard.concurrency')}
                  hint={t('jobs.wizard.concurrencyHint')}
                >
                  {({ id }) => (
                    <div className="flex items-center gap-3">
                      <Slider
                        id={id}
                        min={JOB_CONCURRENCY_MIN}
                        max={JOB_CONCURRENCY_MAX}
                        step={SLIDER_STEP}
                        value={[state.concurrency]}
                        onValueChange={([concurrency]) =>
                          patch({ concurrency: concurrency ?? DEFAULT_CONCURRENCY })
                        }
                        className="flex-1"
                        aria-label={t('jobs.wizard.concurrency')}
                      />
                      <span className="num w-24 shrink-0 text-end text-xs">
                        <Num value={state.concurrency} /> {t('jobs.wizard.parallel')}
                      </span>
                    </div>
                  )}
                </FormField>

                <SectionCard flush>
                  <OptionRow label={t('jobs.wizard.dryRun')} hint={t('jobs.wizard.dryRunHint')}>
                    <Switch
                      checked={state.dryRun}
                      onCheckedChange={(dryRun) => patch({ dryRun })}
                      aria-label={t('jobs.wizard.dryRun')}
                    />
                  </OptionRow>
                  {state.type === 'delete' || state.type === 'restore-versions' ? (
                    <OptionRow
                      label={t('jobs.wizard.includeVersions')}
                      hint={t('jobs.wizard.includeVersionsHint')}
                    >
                      <Switch
                        checked={state.includeVersions}
                        onCheckedChange={(includeVersions) => patch({ includeVersions })}
                        aria-label={t('jobs.wizard.includeVersions')}
                      />
                    </OptionRow>
                  ) : null}
                </SectionCard>

                <div className="flex flex-col gap-2">
                  <span className="text-[0.8125rem] font-medium">{t('jobs.wizard.scheduleLabel')}</span>
                  <SegmentedControl
                    options={scheduleOptions}
                    value={state.scheduleKind}
                    onValueChange={(scheduleKind) => patch({ scheduleKind })}
                    aria-label={t('jobs.wizard.scheduleLabel')}
                  />
                  {state.scheduleKind === 'at' ? (
                    <FormField label={t('jobs.wizard.startAt')}>
                      {({ id }) => (
                        <DatePicker
                          id={id}
                          value={state.runAt}
                          onValueChange={(runAt) => patch({ runAt })}
                          fromDate={new Date()}
                          aria-label={t('jobs.wizard.startAt')}
                        />
                      )}
                    </FormField>
                  ) : null}
                  {state.scheduleKind === 'cron' ? (
                    <FormField
                      label={t('jobs.wizard.cronExpression')}
                      error={cronValid ? undefined : t('jobs.wizard.cronInvalid')}
                      hint={
                        <span className="flex flex-wrap items-center gap-1">
                          <CronText cron={state.cron} />
                          <span className="text-muted-foreground">· {currentTimezone()}</span>
                        </span>
                      }
                    >
                      {({ id, invalid }) => (
                        <div className="flex flex-col gap-1.5">
                          <Input
                            id={id}
                            value={state.cron}
                            onChange={(event) => patch({ cron: event.target.value })}
                            className="font-mono"
                            dir="ltr"
                            aria-invalid={invalid}
                          />
                          <div className="flex flex-wrap gap-1.5">
                            {CRON_PRESETS.map((preset) => (
                              <Button
                                key={preset}
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => patch({ cron: preset })}
                              >
                                <span className="font-mono text-xs" dir="ltr">
                                  {preset}
                                </span>
                              </Button>
                            ))}
                          </div>
                        </div>
                      )}
                    </FormField>
                  ) : null}
                </div>
              </div>
            ),

            review: (
              <div className="flex flex-col gap-4 py-4">
                <SectionCard>
                  <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-[0.8125rem]">
                    <Row label={t('jobs.wizard.review.operation')}>
                      {tDomain(`jobType.${state.type}`)}
                    </Row>
                    <Row label={t('jobs.wizard.review.source')}>
                      <span className="font-mono" dir="ltr">
                        {serverName(serverOptions, state.sourceServerId)} ·{' '}
                        {state.sourceBucket ?? ''}/{state.prefix}
                      </span>
                    </Row>
                    {needsTarget ? (
                      <Row label={t('jobs.wizard.review.target')}>
                        <span className="font-mono" dir="ltr">
                          {serverName(serverOptions, state.targetServerId)} ·{' '}
                          {state.targetBucket ?? ''}/{state.targetPrefix}
                        </span>
                      </Row>
                    ) : null}
                    <Row label={t('jobs.wizard.review.filters')}>
                      <FilterSummary
                        filters={filters}
                        noneLabel={t('jobs.wizard.review.noFilters')}
                      />
                    </Row>
                    <Row label={t('jobs.wizard.review.estimate')}>
                      {estimateResult === undefined ? (
                        t('jobs.wizard.noEstimate')
                      ) : (
                        <EstimateLine
                          result={estimateResult}
                          partialLabel={t('jobs.wizard.partial')}
                        />
                      )}
                    </Row>
                    {needsTarget ? (
                      <Row label={t('jobs.wizard.onConflict')}>
                        {t(`jobs.wizard.conflict.${state.conflict}`)}
                      </Row>
                    ) : null}
                    <Row label={t('jobs.wizard.concurrency')}>
                      <Num value={state.concurrency} />
                    </Row>
                    <Row label={t('jobs.wizard.dryRun')}>
                      {state.dryRun ? t('jobs.wizard.enabled') : t('jobs.wizard.disabled')}
                    </Row>
                    <Row label={t('jobs.wizard.scheduleLabel')}>
                      {state.scheduleKind === 'now'
                        ? t('jobs.wizard.schedule.now')
                        : state.scheduleKind === 'at'
                          ? (state.runAt?.toLocaleString() ?? '')
                          : state.cron}
                    </Row>
                  </dl>
                </SectionCard>

                {jobIsDestructive(state.type) ? (
                  <>
                    <Alert variant="warning">
                      <TriangleAlertIcon />
                      <AlertTitle>{t('jobs.wizard.review.destructiveTitle')}</AlertTitle>
                      <AlertDescription>
                        {t(`jobs.wizard.review.destructiveBody.${state.type}`, {
                          defaultValue: t('jobs.wizard.review.destructiveGeneric'),
                        })}
                      </AlertDescription>
                    </Alert>
                    <label className="flex items-start gap-2.5">
                      <Checkbox
                        checked={state.acknowledged}
                        onCheckedChange={(checked) => patch({ acknowledged: checked === true })}
                        className="mt-0.5"
                      />
                      <span className="flex flex-col">
                        <span className="text-[0.8125rem] font-medium">
                          {t('jobs.wizard.review.acknowledge')}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t('jobs.wizard.review.acknowledgeHint')}
                        </span>
                      </span>
                    </label>
                  </>
                ) : null}
              </div>
            ),
          }}
        />

        <StepperNav
          stepper={stepper}
          onFinish={submit}
          busy={createJob.isPending}
          finishLabel={
            <>
              {state.scheduleKind === 'now' ? <PlayIcon /> : <CalendarClockIcon />}
              {state.scheduleKind === 'now' ? t('jobs.wizard.start') : t('jobs.wizard.schedule.save')}
            </>
          }
          extra={
            <Button type="button" variant="outline" onClick={onClose}>
              {tCommon('action.cancel')}
            </Button>
          }
        />
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function EstimateLine({
  result,
  partialLabel,
}: {
  readonly result: EstimateJobResponse;
  readonly partialLabel: string;
}) {
  return (
    <span className="num flex flex-wrap items-center gap-1.5">
      <span className="font-mono">≈</span>
      <Num value={result.objects} />
      <span aria-hidden="true">·</span>
      <Bytes value={result.bytes} />
      {result.partial ? <span className="text-warning">({partialLabel})</span> : null}
    </span>
  );
}

function FilterSummary({
  filters,
  noneLabel,
}: {
  readonly filters: JobFilters;
  readonly noneLabel: string;
}) {
  const parts: string[] = [];
  if (filters.glob !== null) parts.push(filters.glob);
  if (filters.modifiedAfter !== null) parts.push(`≥ ${filters.modifiedAfter.slice(0, 10)}`);
  if (filters.modifiedBefore !== null) parts.push(`≤ ${filters.modifiedBefore.slice(0, 10)}`);
  for (const [key, value] of Object.entries(filters.tags)) parts.push(`${key}=${value}`);
  if (parts.length === 0 && filters.minSize === null && filters.maxSize === null) {
    return <span className="text-muted-foreground">{noneLabel}</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {parts.map((part) => (
        <span key={part} className="font-mono text-xs" dir="ltr">
          {part}
        </span>
      ))}
      {filters.minSize === null ? null : (
        <span className="num text-xs">
          ≥ <Bytes value={filters.minSize} />
        </span>
      )}
      {filters.maxSize === null ? null : (
        <span className="num text-xs">
          ≤ <Bytes value={filters.maxSize} />
        </span>
      )}
    </span>
  );
}

function serverName(
  options: readonly ComboboxOption<string>[],
  serverId: string | null,
): string {
  if (serverId === null) return '';
  return options.find((option) => option.value === serverId)?.label ?? serverId;
}

/** The schedule's timezone: the browser's, which is what the operator is reading in. */
function currentTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

registerDialog('new-job', NewJobDialog);
