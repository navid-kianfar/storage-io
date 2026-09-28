import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/app/Alert';
import { Button } from '@/components/app/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/app/Dialog';
import { Input } from '@/components/app/Input';
import { Label } from '@/components/app/Label';
import { Spinner } from '@/components/app/Spinner';
import { toastProblem } from '@/lib/api/problems';
import { keyName, parentPrefix, useRenameObject, type ObjectScope } from '../api';

/**
 * Rename (F2). S3 has no rename, so the API copies the object to the new key and
 * deletes the old one; the dialog says that, because it matters — the copy gets a
 * new `LastModified` and, on a versioned bucket, the old key keeps its versions.
 */
export function RenameObjectDialog({
  open,
  onOpenChange,
  scope,
  objectKey,
  onRenamed,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly scope: ObjectScope;
  readonly objectKey: string;
  readonly onRenamed?: (newKey: string) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const nameId = useId();
  const [name, setName] = useState(() => keyName(objectKey));
  const rename = useRenameObject(scope);

  const prefix = parentPrefix(objectKey);
  const trimmed = name.trim();
  const invalid = trimmed.includes('/');
  const newKey = `${prefix}${trimmed}`;
  const canSubmit =
    trimmed !== '' && !invalid && newKey !== objectKey && !rename.isPending;

  function submit(): void {
    if (!canSubmit) return;
    rename.mutate(
      { key: objectKey, newKey },
      {
        onSuccess: () => {
          toast.success(t('browse.renameDialog.renamed'), { description: newKey });
          onOpenChange(false);
          onRenamed?.(newKey);
        },
        onError: (error) => toastProblem(error, tCommon),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setName(keyName(objectKey));
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('browse.renameDialog.title')}</DialogTitle>
          <DialogDescription>{t('browse.renameDialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nameId}>{t('browse.renameDialog.newName')}</Label>
          <Input
            id={nameId}
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
            aria-invalid={invalid}
            className="ltr-isolate font-mono"
          />
          <p className="ltr-isolate font-mono text-[0.8125rem] text-muted-foreground">{newKey}</p>
        </div>

        {invalid ? (
          <Alert variant="destructive">
            <AlertDescription>{t('browse.newFolder.invalid')}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={rename.isPending}>
            {tCommon('action.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {rename.isPending ? <Spinner /> : null}
            {tCommon('action.rename')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
