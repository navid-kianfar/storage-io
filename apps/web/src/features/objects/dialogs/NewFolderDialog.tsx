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
import { registerDialog, type DialogProps } from '@/lib/dialogs/registry';
import { useCreateFolder } from '../api';

/**
 * New folder — `?dialog=new-folder`, with `d_server`, `d_bucket` and `d_prefix`.
 *
 * S3 has no folders; this writes an empty object whose key ends in `/`, which is
 * what every S3 console means by one. The dialog says so rather than pretending
 * otherwise, and it rejects a name with a slash in it: a nested folder is two
 * markers, and creating one silently would be a surprise.
 */
function NewFolderDialog({ params, onClose }: DialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const nameId = useId();
  const [name, setName] = useState('');

  const scope = { serverId: params.server ?? '', bucket: params.bucket ?? '' };
  const prefix = params.prefix ?? '';
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

registerDialog('new-folder', NewFolderDialog);

export { NewFolderDialog };
