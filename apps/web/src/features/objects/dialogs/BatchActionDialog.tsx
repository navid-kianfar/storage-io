import type {
  ObjectBatchAction,
  ObjectBatchRequest,
  ObjectBatchResponse,
} from '@storage-io/contracts';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  Button,
  Combobox,
  DatePicker,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  RadioGroup,
  RadioGroupItem,
  Spinner,
  Switch,
  TagEditor,
} from '@/components/app';
import { useApiError } from '@/lib/api/useApiError';
import { useObjectBatch, type ObjectScope } from '../api';

/**
 * Tags, storage class, retention or legal hold over the selected objects.
 *
 * It calls `POST …/objects/batch` directly, which applies the change while the
 * operator waits and answers per key. The caller only opens it for a selection the
 * endpoint accepts — at most 1000 explicit keys and no folders — and hands anything
 * larger to the job wizard, because a set nobody can wait for is not a dialog.
 *
 * A provider that lacks the feature altogether answers 409 `NOT_SUPPORTED`; a
 * bucket that is merely not configured for it (object lock off, say) answers with
 * one error per key. Both are shown, because they mean different things.
 */

/** The classes S3 defines; a provider that has none of them is gated out upstream. */
const STORAGE_CLASSES = ['STANDARD', 'STANDARD_IA', 'INTELLIGENT_TIERING', 'GLACIER'] as const;

/** Enough failures to see the pattern; the rest is a number. */
const ERRORS_SHOWN = 5;

export function BatchActionDialog({
  action,
  scope,
  keys,
  onOpenChange,
  onApplied,
}: {
  /** `null` keeps the dialog closed; the action decides what it shows. */
  readonly action: ObjectBatchAction | null;
  readonly scope: ObjectScope;
  readonly keys: readonly string[];
  readonly onOpenChange: (open: boolean) => void;
  readonly onApplied?: () => void;
}) {
  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {action === null ? null : (
          // Keyed by the action, so every opening mounts a fresh form: the previous
          // selection's tags are not a sensible default for this one.
          <BatchActionForm
            key={action}
            action={action}
            scope={scope}
            keys={keys}
            onOpenChange={onOpenChange}
            onApplied={onApplied}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BatchActionForm({
  action,
  scope,
  keys,
  onOpenChange,
  onApplied,
}: {
  readonly action: ObjectBatchAction;
  readonly scope: ObjectScope;
  readonly keys: readonly string[];
  readonly onOpenChange: (open: boolean) => void;
  readonly onApplied?: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();
  const batch = useObjectBatch(scope);
  const holdId = useId();

  const [tags, setTags] = useState<Readonly<Record<string, string>>>({});
  const [storageClass, setStorageClass] = useState<string | null>(null);
  const [mode, setMode] = useState<'GOVERNANCE' | 'COMPLIANCE'>('GOVERNANCE');
  const [until, setUntil] = useState<Date | null>(null);
  const [legalHold, setLegalHold] = useState(true);

  const request = useMemo<ObjectBatchRequest | null>(() => {
    if (keys.length === 0) return null;
    const batchKeys = [...keys];
    switch (action) {
      case 'tags':
        return { keys: batchKeys, action: 'tags', payload: { tags } };
      case 'storage-class':
        return storageClass === null
          ? null
          : { keys: batchKeys, action: 'storage-class', payload: { storageClass } };
      case 'retention':
        return until === null
          ? null
          : { keys: batchKeys, action: 'retention', payload: { mode, until: until.toISOString() } };
      case 'legal-hold':
        return { keys: batchKeys, action: 'legal-hold', payload: { legalHold } };
    }
  }, [action, keys, tags, storageClass, mode, until, legalHold]);

  function report(response: ObjectBatchResponse): void {
    if (response.errors.length === 0) {
      toast.success(t('browse.batch.applied', { count: response.updated }));
    } else {
      const shown = response.errors.slice(0, ERRORS_SHOWN);
      toast.warning(
        t('browse.batch.partial', { updated: response.updated, failed: response.errors.length }),
        { description: shown.map((error) => `${error.key}: ${error.message}`).join('\n') },
      );
    }
    onOpenChange(false);
    onApplied?.();
  }

  function submit(): void {
    if (request === null || batch.isPending) return;
    batch.mutate(request, {
      onSuccess: report,
      onError: (error) => apiError.toastError(error, t('browse.batch.failed')),
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t(`browse.batch.title.${action}`, { count: keys.length })}</DialogTitle>
        <DialogDescription>
          {t('browse.batch.description', { count: keys.length })}
        </DialogDescription>
      </DialogHeader>

      {action === 'tags' ? (
        <TagEditor tags={tags} onTagsChange={setTags} hint={t('browse.batch.tagsHint')} />
      ) : null}

      {action === 'storage-class' ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t('browse.upload.storageClass')}</span>
          <Combobox
            options={STORAGE_CLASSES.map((name) => ({ value: name, label: name }))}
            value={storageClass}
            onValueChange={setStorageClass}
            placeholder={tCommon('form.comboboxPlaceholder')}
            aria-label={t('browse.upload.storageClass')}
          />
          <p className="text-[0.8125rem] text-muted-foreground">
            {t('browse.batch.storageClassHint')}
          </p>
        </div>
      ) : null}

      {action === 'retention' ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t('browse.batch.retentionMode')}</span>
            <RadioGroup
              value={mode}
              onValueChange={(value) =>
                setMode(value === 'COMPLIANCE' ? 'COMPLIANCE' : 'GOVERNANCE')
              }
              className="gap-2"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="GOVERNANCE" id="batch-mode-governance" />
                <Label htmlFor="batch-mode-governance" className="font-normal">
                  {t('browse.batch.governance')}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="COMPLIANCE" id="batch-mode-compliance" />
                <Label htmlFor="batch-mode-compliance" className="font-normal">
                  {t('browse.batch.compliance')}
                </Label>
              </div>
            </RadioGroup>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="batch-until">{t('browse.batch.retainUntil')}</Label>
            <DatePicker
              id="batch-until"
              value={until}
              onValueChange={setUntil}
              fromDate={new Date()}
              clearable={false}
              aria-label={t('browse.batch.retainUntil')}
            />
          </div>
          {mode === 'COMPLIANCE' ? (
            <Alert variant="warning">
              <AlertDescription>{t('browse.batch.complianceWarning')}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {action === 'legal-hold' ? (
        <div className="flex items-center justify-between gap-4 rounded-lg border px-(--card-pad) py-3">
          <Label htmlFor={holdId} className="font-normal">
            {t('browse.batch.legalHoldOn')}
          </Label>
          <Switch
            id={holdId}
            checked={legalHold}
            onCheckedChange={setLegalHold}
            aria-label={t('browse.batch.legalHoldOn')}
          />
        </div>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={batch.isPending}>
          {tCommon('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={request === null || batch.isPending}>
          {batch.isPending ? <Spinner /> : null}
          {t('browse.batch.apply')}
        </Button>
      </DialogFooter>
    </>
  );
}
