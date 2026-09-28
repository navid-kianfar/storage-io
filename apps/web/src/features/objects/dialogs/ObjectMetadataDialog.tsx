import type { ObjectMeta } from '@storage-io/contracts';
import { useState } from 'react';
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
import { FormField } from '@/components/app/FormField';
import { Spinner } from '@/components/app/Spinner';
import { TagEditor } from '@/components/app/TagEditor';
import { toastProblem } from '@/lib/api/problems';
import { useSaveObjectMetadata, type ObjectScope } from '../api';

/**
 * Edit metadata. `PUT …/metadata` replaces the whole set, which is what S3 does —
 * a metadata update rewrites the object's headers — so the dialog starts from what
 * is there and sends all of it back.
 */
export function ObjectMetadataDialog({
  open,
  onOpenChange,
  scope,
  objectKey,
  meta,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly scope: ObjectScope;
  readonly objectKey: string;
  readonly meta: ObjectMeta | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <Body
          scope={scope}
          objectKey={objectKey}
          meta={meta}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

function Body({
  scope,
  objectKey,
  meta,
  onDone,
}: {
  readonly scope: ObjectScope;
  readonly objectKey: string;
  readonly meta: ObjectMeta | undefined;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();

  const [contentType, setContentType] = useState(meta?.contentType ?? '');
  const [cacheControl, setCacheControl] = useState(meta?.cacheControl ?? '');
  const [disposition, setDisposition] = useState(meta?.contentDisposition ?? '');
  const [metadata, setMetadata] = useState<Readonly<Record<string, string>>>(meta?.metadata ?? {});

  const save = useSaveObjectMetadata(scope);

  function submit(): void {
    if (save.isPending) return;
    save.mutate(
      {
        key: objectKey,
        contentType: contentType.trim() === '' ? null : contentType.trim(),
        cacheControl: cacheControl.trim() === '' ? null : cacheControl.trim(),
        contentDisposition: disposition.trim() === '' ? null : disposition.trim(),
        metadata,
      },
      {
        onSuccess: () => {
          toast.success(t('browse.metadataDialog.saved'));
          onDone();
        },
        onError: (error) => toastProblem(error, tCommon),
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{t('browse.metadataDialog.title')}</DialogTitle>
        <DialogDescription className="ltr-isolate font-mono">{objectKey}</DialogDescription>
      </DialogHeader>

      <div className="grid items-start gap-4 sm:grid-cols-2">
        <FormField label={t('browse.metadataDialog.contentType')}>
          {({ id }) => (
            <Input
              id={id}
              value={contentType}
              onChange={(event) => setContentType(event.target.value)}
              placeholder="application/octet-stream"
              className="ltr-isolate font-mono"
            />
          )}
        </FormField>
        <FormField label={t('browse.metadataDialog.cacheControl')}>
          {({ id }) => (
            <Input
              id={id}
              value={cacheControl}
              onChange={(event) => setCacheControl(event.target.value)}
              placeholder="max-age=3600"
              className="ltr-isolate font-mono"
            />
          )}
        </FormField>
        <FormField
          className="sm:col-span-2"
          label={t('browse.metadataDialog.contentDisposition')}
        >
          {({ id }) => (
            <Input
              id={id}
              value={disposition}
              onChange={(event) => setDisposition(event.target.value)}
              placeholder="inline"
              className="ltr-isolate font-mono"
            />
          )}
        </FormField>
      </div>

      <FormField label={t('browse.metadataDialog.custom')}>
        {() => (
          <TagEditor
            tags={metadata}
            onTagsChange={setMetadata}
            hint={t('browse.metadataDialog.customHint')}
          />
        )}
      </FormField>

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={save.isPending}>
          {tCommon('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={save.isPending}>
          {save.isPending ? <Spinner /> : null}
          {tCommon('action.save')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
