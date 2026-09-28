import type { LifecycleRule } from '@storage-io/contracts';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/app/Alert';
import { Button } from '@/components/app/Button';
import { Combobox } from '@/components/app/Combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/app/Dialog';
import { Input } from '@/components/app/Input';
import { FormField } from '@/components/app/FormField';
import { OptionRow } from '@/components/app/FormRow';
import { Spinner } from '@/components/app/Spinner';
import { Switch } from '@/components/app/Switch';
import { TagEditor } from '@/components/app/TagEditor';

/**
 * Add or edit a lifecycle rule. The same dialog serves the bucket's own Lifecycle
 * section and the bucket list's "Apply lifecycle rule" bulk action, so a rule
 * means exactly one thing in both places.
 *
 * Every action is a day count with a switch beside it, as the concept draws. A
 * rule with no action at all is rejected here rather than sent: S3 accepts it and
 * then silently does nothing, which is worse than an error.
 */

type Scope = 'all' | 'prefix' | 'tag';

const DEFAULT_STORAGE_CLASSES = ['STANDARD', 'STANDARD_IA', 'GLACIER', 'REDUCED_REDUNDANCY'];

export interface LifecycleRuleDraft {
  readonly rule: LifecycleRule;
}

function scopeOf(rule: LifecycleRule): Scope {
  if (Object.keys(rule.tags).length > 0) return 'tag';
  if (rule.prefix !== '') return 'prefix';
  return 'all';
}

export function emptyLifecycleRule(): LifecycleRule {
  return {
    id: '',
    enabled: true,
    prefix: '',
    tags: {},
    expireDays: null,
    noncurrentExpireDays: null,
    abortMultipartDays: null,
    transition: null,
    expiredDeleteMarkers: false,
  };
}

export function LifecycleRuleDialog({
  open,
  onOpenChange,
  rule,
  existingIds,
  storageClasses,
  busy = false,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The rule being edited, or null for a new one. */
  readonly rule: LifecycleRule | null;
  /** Ids already on the bucket, so a new rule cannot collide with one. */
  readonly existingIds: readonly string[];
  readonly storageClasses?: readonly string[];
  readonly busy?: boolean;
  readonly onSubmit: (rule: LifecycleRule) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <LifecycleRuleDialogBody
          rule={rule}
          existingIds={existingIds}
          storageClasses={storageClasses ?? DEFAULT_STORAGE_CLASSES}
          busy={busy}
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
        />
      ) : null}
    </Dialog>
  );
}

function LifecycleRuleDialogBody({
  rule,
  existingIds,
  storageClasses,
  busy,
  onCancel,
  onSubmit,
}: {
  readonly rule: LifecycleRule | null;
  readonly existingIds: readonly string[];
  readonly storageClasses: readonly string[];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (rule: LifecycleRule) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();

  const initial = rule ?? emptyLifecycleRule();
  const isEdit = rule !== null;

  const [id, setId] = useState(initial.id);
  const [scope, setScope] = useState<Scope>(scopeOf(initial));
  const [prefix, setPrefix] = useState(initial.prefix);
  const [tags, setTags] = useState<Readonly<Record<string, string>>>(initial.tags);
  const [expire, setExpire] = useState(numberField(initial.expireDays, '90'));
  const [noncurrent, setNoncurrent] = useState(numberField(initial.noncurrentExpireDays, '14'));
  const [abort, setAbort] = useState(numberField(initial.abortMultipartDays, '7'));
  const [transition, setTransition] = useState(
    numberField(initial.transition === null ? null : initial.transition.days, '30'),
  );
  const [storageClass, setStorageClass] = useState(
    initial.transition?.storageClass ?? storageClasses[1] ?? storageClasses[0] ?? 'STANDARD_IA',
  );
  const [deleteMarkers, setDeleteMarkers] = useState(initial.expiredDeleteMarkers);

  const trimmedId = id.trim();
  const takenIds = useMemo(
    () => existingIds.filter((existing) => existing !== initial.id),
    [existingIds, initial.id],
  );
  const duplicateId = trimmedId.length > 0 && takenIds.includes(trimmedId);

  const hasAction =
    expire.enabled || noncurrent.enabled || abort.enabled || transition.enabled || deleteMarkers;
  const canSubmit = trimmedId.length > 0 && !duplicateId && hasAction && !busy;

  const classOptions = useMemo(
    () => storageClasses.map((name) => ({ value: name, label: name })),
    [storageClasses],
  );

  function submit(): void {
    if (!canSubmit) return;
    onSubmit({
      id: trimmedId,
      enabled: initial.enabled,
      prefix: scope === 'prefix' ? prefix.trim() : '',
      tags: scope === 'tag' ? tags : {},
      expireDays: expire.enabled ? expire.parsed : null,
      noncurrentExpireDays: noncurrent.enabled ? noncurrent.parsed : null,
      abortMultipartDays: abort.enabled ? abort.parsed : null,
      transition:
        transition.enabled && transition.parsed !== null
          ? { days: transition.parsed, storageClass }
          : null,
      expiredDeleteMarkers: deleteMarkers,
    });
  }

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>
          {isEdit ? t('bucket.lifecycle.dialog.editTitle') : t('bucket.lifecycle.dialog.addTitle')}
        </DialogTitle>
        <DialogDescription>{t('bucket.lifecycle.dialog.description')}</DialogDescription>
      </DialogHeader>

      <div className="grid items-start gap-4 sm:grid-cols-2">
        <FormField
          label={t('bucket.lifecycle.dialog.name')}
          error={duplicateId ? t('bucket.lifecycle.dialog.duplicateId') : undefined}
          hint={t('bucket.lifecycle.dialog.nameHint')}
        >
          {({ id: fieldId, describedBy, invalid }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              value={id}
              onChange={(event) => setId(event.target.value)}
              aria-invalid={invalid}
              autoComplete="off"
              spellCheck={false}
              className="ltr-isolate font-mono"
            />
          )}
        </FormField>
        <FormField label={t('bucket.lifecycle.dialog.scope')}>
          {({ id: fieldId }) => (
            <Combobox
              id={fieldId}
              options={[
                { value: 'all', label: t('bucket.lifecycle.dialog.scopeAll') },
                { value: 'prefix', label: t('bucket.lifecycle.dialog.scopePrefix') },
                { value: 'tag', label: t('bucket.lifecycle.dialog.scopeTag') },
              ]}
              value={scope}
              onValueChange={(next) => setScope(next ?? 'all')}
              aria-label={t('bucket.lifecycle.dialog.scope')}
            />
          )}
        </FormField>
        {scope === 'prefix' ? (
          <FormField className="sm:col-span-2" label={t('bucket.lifecycle.dialog.prefix')}>
            {({ id: fieldId }) => (
              <Input
                id={fieldId}
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                placeholder="raw/"
                className="ltr-isolate font-mono"
              />
            )}
          </FormField>
        ) : null}
        {scope === 'tag' ? (
          <FormField className="sm:col-span-2" label={t('bucket.lifecycle.dialog.tagFilter')}>
            {() => <TagEditor tags={tags} onTagsChange={setTags} limit={4} />}
          </FormField>
        ) : null}
      </div>

      <div className="rounded-lg border px-(--card-pad)">
        <DayAction
          label={t('bucket.lifecycle.dialog.expire')}
          hint={t('bucket.lifecycle.dialog.expireHint')}
          field={expire}
          onChange={setExpire}
        />
        <DayAction
          label={t('bucket.lifecycle.dialog.noncurrent')}
          hint={t('bucket.lifecycle.dialog.noncurrentHint')}
          field={noncurrent}
          onChange={setNoncurrent}
        />
        <DayAction
          label={t('bucket.lifecycle.dialog.abort')}
          hint={t('bucket.lifecycle.dialog.abortHint')}
          field={abort}
          onChange={setAbort}
        />
        <DayAction
          label={t('bucket.lifecycle.dialog.transition')}
          hint={t('bucket.lifecycle.dialog.transitionHint')}
          field={transition}
          onChange={setTransition}
        >
          <Combobox
            options={classOptions}
            value={storageClass}
            onValueChange={(next) => {
              if (next !== null) setStorageClass(next);
            }}
            disabled={!transition.enabled}
            aria-label={t('bucket.lifecycle.dialog.transition')}
            className="w-40"
          />
        </DayAction>
        <OptionRow label={t('bucket.lifecycle.dialog.deleteMarkers')}>
          <Switch
            checked={deleteMarkers}
            onCheckedChange={setDeleteMarkers}
            aria-label={t('bucket.lifecycle.dialog.deleteMarkers')}
          />
        </OptionRow>
      </div>

      {hasAction ? (
        <Alert variant="warning">
          <AlertTitle>{t('bucket.lifecycle.dialog.complianceWarning')}</AlertTitle>
          <AlertDescription>
            {t('bucket.lifecycle.dialog.complianceWarningDetail')}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <AlertDescription>{t('bucket.lifecycle.dialog.needsOneAction')}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {tCommon('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {busy ? <Spinner /> : null}
          {isEdit ? tCommon('action.save') : tCommon('action.create')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/* ------------------------- the "N days" switch pair ---------------------- */

interface DayField {
  readonly enabled: boolean;
  readonly text: string;
  readonly parsed: number | null;
}

function numberField(value: number | null, fallback: string): DayField {
  const text = value === null ? fallback : String(value);
  return { enabled: value !== null, text, parsed: value ?? Number.parseInt(fallback, 10) };
}

function DayAction({
  label,
  hint,
  field,
  onChange,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly field: DayField;
  readonly onChange: (field: DayField) => void;
  readonly children?: ReactNode;
}) {
  const { t } = useTranslation('pages');
  const inputId = useId();
  const invalid = field.enabled && (field.parsed === null || field.parsed < 1);
  const daysLabel = t('bucket.versioning.days');

  return (
    <OptionRow label={label} hint={hint}>
      {children}
      <Input
        id={inputId}
        value={field.text}
        inputMode="numeric"
        disabled={!field.enabled}
        aria-invalid={invalid}
        aria-label={`${label} — ${daysLabel}`}
        onChange={(event) => {
          const text = event.target.value;
          const parsed = Number.parseInt(text, 10);
          onChange({ ...field, text, parsed: Number.isFinite(parsed) ? parsed : null });
        }}
        className="num w-20"
      />
      <span className="text-[0.8125rem] text-muted-foreground">{daysLabel}</span>
      <Switch
        checked={field.enabled}
        onCheckedChange={(checked) => onChange({ ...field, enabled: checked })}
        aria-label={label}
      />
    </OptionRow>
  );
}
