import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
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
import type { BucketScope } from '@/lib/entities/resolve';
import { useCreateFolder } from '../api';

/**
 * New folder. It creates nothing addressable and is dismissed as soon as it is
 * answered, so per docs/ROUTES.md it stays component state and has no URL.
 *
 * S3 has no folders; this writes an empty object whose key ends in `/`, which is
 * what every S3 console means by one. The dialog says so rather than pretending
 * otherwise, and it rejects a name with a slash in it: a nested folder is two
 * markers, and creating one silently would be a surprise.
 */
export interface NewFolderDialogProps {
  readonly scope: BucketScope;
  readonly prefix: string;
  readonly onClose: () => void;
}

function NewFolderDialog({ scope, prefix, onClose }: NewFolderDialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const nameId = useId();
  const [name, setName] = useState('');

  const create = useCreateFolder(scope);

  const trimmed = name.trim();
  const invalid = trimmed.includes('/');
  const canSubmit = trimmed !== '' && !invalid && !create.isPending && scope.bucket !== '';
  const fullPrefix = `${prefix}${trimmed}/`;

  function submit(): void {
    if (!canSubmit) return;
    create.mutate(fullPrefix, {
      onSuccess: () => {
        toast.success(t('browse.newFolder.created'), { description: fullPrefix });
        onClose();
      },
      onError: (error) => toastProblem(error, tCommon),
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('browse.newFolder.title')}</DialogTitle>
          <DialogDescription>{t('browse.newFolder.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nameId}>{t('browse.newFolder.name')}</Label>
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
          <p className="ltr-isolate font-mono text-[0.8125rem] text-muted-foreground">
            {invalid ? t('browse.newFolder.invalid') : `${scope.bucket}/${fullPrefix}`}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            {tCommon('action.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {create.isPending ? <Spinner /> : null}
            {tCommon('action.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { NewFolderDialog };
