import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/app/Alert';
import { Checkbox } from '@/components/app/Checkbox';
import { ConfirmDialog } from '@/components/app/ConfirmDialog';
import { Label } from '@/components/app/Label';
import { toastProblem } from '@/lib/api/problems';
import { useDeleteObjects, type ObjectScope } from '../api';
import type { Entry } from '../entries';

/**
 * Delete, versioning-aware.
 *
 * On a versioned bucket a delete writes a delete marker and the earlier versions
 * stay recoverable — so the dialog says "recoverable" rather than "permanent", and
 * offers the one option that does make it permanent. On an unversioned bucket it
 * says the opposite, because there it is true.
 *
 * Folders are sent as `prefixes`, which the API turns into a job when the set is
 * large. One request either way; the answer says whether it became a job.
 */
export function DeleteObjectsDialog({
  open,
  onOpenChange,
  scope,
  entries,
  versioned,
  onDeleted,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly scope: ObjectScope;
  readonly entries: readonly Entry[];
  readonly versioned: boolean;
  readonly onDeleted?: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const versionsId = useId();
  const [allVersions, setAllVersions] = useState(false);
  const remove = useDeleteObjects(scope);

  const prefixes = entries.filter((entry) => entry.kind === 'prefix');
  const objects = entries.filter((entry) => entry.kind === 'object');
  const many = entries.length > 1;

  function submit(): void {
    if (remove.isPending || entries.length === 0) return;
    remove.mutate(
      {
        objects: objects.map((entry) =>
          entry.kind === 'object'
            ? { key: entry.object.key, versionId: entry.object.versionId ?? undefined }
            : { key: '' },
        ),
        prefixes: prefixes.map((entry) => (entry.kind === 'prefix' ? entry.prefix : '')),
        allVersions,
      },
      {
        onSuccess: (response) => {
          if (response.job !== null) {
            toast.info(t('browse.delete.asJob'));
          } else if (response.errors.length > 0) {
            toast.warning(
              t('browse.delete.partial', {
                deleted: response.deleted,
                failed: response.errors.length,
              }),
              { description: response.errors.map((error) => error.key).join('\n') },
            );
          } else {
            toast.success(t('browse.delete.deleted', { count: response.deleted }));
          }
          setAllVersions(false);
          onOpenChange(false);
          onDeleted?.();
        },
        onError: (error) => toastProblem(error, tCommon),
      },
    );
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setAllVersions(false);
        onOpenChange(next);
      }}
      destructive
      busy={remove.isPending}
      title={many ? t('browse.delete.title', { count: entries.length }) : t('browse.delete.titleOne')}
      description={versioned ? t('browse.delete.versioned') : t('browse.delete.unversioned')}
      confirmLabel={tCommon('action.delete')}
      onConfirm={submit}
    >
      <div className="flex flex-col gap-3">
        <ul className="ltr-isolate max-h-32 overflow-auto rounded-md border bg-muted px-3 py-2 font-mono text-sm">
          {entries.map((entry) => (
            <li key={entry.id} className="truncate">
              {entry.kind === 'prefix' ? `${entry.name}/` : entry.name}
            </li>
          ))}
        </ul>

        {prefixes.length > 0 ? (
          <Alert variant="warning">
            <AlertDescription>{t('browse.delete.folderWarning')}</AlertDescription>
          </Alert>
        ) : null}

        {versioned ? (
          <div className="flex items-start gap-2">
            <Checkbox
              id={versionsId}
              checked={allVersions}
              onCheckedChange={(checked) => setAllVersions(checked === true)}
              className="mt-0.5"
            />
            <Label htmlFor={versionsId} className="flex flex-col items-start gap-0.5 font-normal">
              <span className="text-sm font-medium">{t('browse.delete.allVersions')}</span>
              <span className="text-[0.8125rem] text-muted-foreground">
                {t('browse.delete.allVersionsHint')}
              </span>
            </Label>
          </div>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
