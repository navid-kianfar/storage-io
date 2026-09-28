import { useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/app/Alert';
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
import { FileDropzone, type DroppedFile } from '@/components/app/FileDropzone';
import { Input } from '@/components/app/Input';
import { FormField } from '@/components/app/FormField';
import { OptionRow } from '@/components/app/FormRow';
import { Switch } from '@/components/app/Switch';
import { TagEditor } from '@/components/app/TagEditor';
import { useBucketDetail, useBucketQuota } from '@/features/buckets/api';
import { useServerList } from '@/features/shell/api';
import { enqueueUploads } from '@/features/transfers/engine';
import { useBucketScope, type BucketScope } from '@/lib/entities/resolve';
import { useFormat } from '@/lib/format/FormatProvider';
import { guessContentType } from '../fileKind';

/**
 * Upload — the `/buckets/$bucketId/upload/$` route, rendered over the object
 * browser. The bucket is the route's id and the splat is the destination prefix,
 * so the dialog never has to ask which bucket it is uploading to: the palette's
 * "Upload" goes to `/browse`, where a bucket is picked first.
 *
 * `FileDropzone` is the only file input in the app and it already preserves the
 * relative path of a dropped folder; this dialog passes those paths straight
 * through to the transfer engine, which is what makes "upload folder" keep its
 * shape instead of flattening into one prefix.
 *
 * The quota line is computed, not decorative: the bucket's current size plus what
 * is about to be sent, against its limit. A selection that would go over says so
 * before anything is uploaded.
 */

const STORAGE_CLASSES = ['STANDARD', 'STANDARD_IA', 'REDUCED_REDUNDANCY', 'GLACIER'] as const;

/** One stable placeholder while the bucket id resolves; the queries are disabled. */
const EMPTY_SCOPE: BucketScope = { serverId: '', bucket: '' };

export interface UploadDialogProps {
  /** The resolved bucket; `null` while its id is still resolving. */
  readonly scope: BucketScope | null;
  /** The bucket's opaque id, which the transfer carries for "open location". */
  readonly bucketId: string;
  readonly initialPrefix: string;
  readonly onClose: () => void;
}

function UploadDialog({ scope, bucketId, initialPrefix, onClose }: UploadDialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const format = useFormat();

  const servers = useServerList();
  const serverId = scope?.serverId ?? null;
  const bucket = scope?.bucket ?? '';
  const [prefix, setPrefix] = useState(initialPrefix);
  const [files, setFiles] = useState<readonly DroppedFile[]>([]);
  const [storageClass, setStorageClass] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [detectType, setDetectType] = useState(true);
  const [showExtras, setShowExtras] = useState(false);
  const [metadata, setMetadata] = useState<Readonly<Record<string, string>>>({});
  const [tags, setTags] = useState<Readonly<Record<string, string>>>({});

  const scopeReady = scope !== null;
  const bucketRef = scope ?? EMPTY_SCOPE;
  const detail = useBucketDetail(bucketRef, scopeReady);
  const quota = useBucketQuota(bucketRef, scopeReady);

  const totalBytes = files.reduce((sum, item) => sum + item.file.size, 0);
  const limitBytes = quota.data?.quota?.limitBytes ?? null;
  const usedBytes = quota.data?.usage.sizeBytes ?? null;
  const ratioAfter =
    limitBytes === null || limitBytes <= 0 || usedBytes === null
      ? null
      : (usedBytes + totalBytes) / limitBytes;
  const overQuota = ratioAfter !== null && ratioAfter > 1;

  const serverName =
    servers.data?.items.find((item) => item.id === serverId || item.name === serverId)?.name ??
    serverId ??
    '';

  const normalizedPrefix = prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`;
  const canSubmit = scopeReady && files.length > 0 && !overQuota;

  function submit(): void {
    if (!canSubmit || serverId === null) return;
    enqueueUploads({
      scope: { serverId, serverName, bucket, bucketId },
      items: files.map((dropped) => ({
        file: dropped.file,
        relativePath: dropped.relativePath,
      })),
      destPrefix: normalizedPrefix,
      storageClass,
      overwrite,
      detectContentType: detectType,
      metadata,
      tags,
      guessContentType,
    });
    toast.info(t('browse.upload.started'), {
      description: t('browse.upload.selected', {
        count: files.length,
        size: format.bytes(totalBytes),
      }),
    });
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {/* Neutral until the bucket is known: "Upload to …" with a placeholder
                where the name goes reads as a broken string, not as a heading. */}
            {bucket === '' ? t('browse.upload.titleNeutral') : t('browse.upload.title', { bucket })}
          </DialogTitle>
          <DialogDescription>{t('browse.upload.description')}</DialogDescription>
        </DialogHeader>

        <FileDropzone
          files={files}
          onFilesChange={setFiles}
          allowFolders
          multiple
        />

        <div className="grid items-start gap-4 sm:grid-cols-2">
          <FormField label={t('browse.upload.prefix')}>
            {({ id }) => (
              <Input
                id={id}
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                placeholder="2026/09/"
                className="ltr-isolate font-mono"
              />
            )}
          </FormField>
          <FormField label={t('browse.upload.storageClass')}>
            {({ id }) => (
              <Combobox
                id={id}
                options={STORAGE_CLASSES.map((name) => ({ value: name, label: name }))}
                value={storageClass}
                onValueChange={setStorageClass}
                placeholder={detail.data?.defaultStorageClass ?? 'STANDARD'}
                clearable
              />
            )}
          </FormField>
        </div>

        <div className="rounded-lg border px-(--card-pad)">
          <OptionRow label={t('browse.upload.overwrite')} hint={t('browse.upload.overwriteHint')}>
            <Switch
              checked={overwrite}
              onCheckedChange={setOverwrite}
              aria-label={t('browse.upload.overwrite')}
            />
          </OptionRow>
          <OptionRow label={t('browse.upload.detectType')} hint={t('browse.upload.detectTypeHint')}>
            <Switch
              checked={detectType}
              onCheckedChange={setDetectType}
              aria-label={t('browse.upload.detectType')}
            />
          </OptionRow>
          <OptionRow label={t('browse.upload.extras')} hint={t('browse.upload.extrasHint')}>
            <Button variant="outline" size="sm" onClick={() => setShowExtras((open) => !open)}>
              {showExtras ? tCommon('action.showLess') : tCommon('action.showMore')}
            </Button>
          </OptionRow>
        </div>

        {showExtras ? (
          <div className="flex flex-col gap-4 rounded-lg border p-(--card-pad)">
            <FormField label={t('browse.metadataDialog.custom')}>
              {() => (
                <TagEditor
                  tags={metadata}
                  onTagsChange={setMetadata}
                  hint={t('browse.metadataDialog.customHint')}
                />
              )}
            </FormField>
            <FormField label={t('browse.inspector.tabs.tags')}>
              {() => <TagEditor tags={tags} onTagsChange={setTags} />}
            </FormField>
          </div>
        ) : null}

        {files.length > 0 ? (
          <Alert variant={overQuota ? 'destructive' : 'info'}>
            <AlertDescription>
              {t('browse.upload.selected', {
                count: files.length,
                size: format.bytes(totalBytes),
              })}
              {ratioAfter === null ? null : (
                <>
                  {' · '}
                  {t('browse.upload.quotaAfter', { ratio: format.percent(ratioAfter) })}
                </>
              )}
              {overQuota ? ` · ${t('browse.upload.overQuota')}` : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {t('browse.upload.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { UploadDialog };

/** `/buckets/$bucketId/upload/$` — the upload dialog over the object browser. */
export function UploadRoute() {
  const navigate = useNavigate();
  const { bucketId, _splat } = useParams({ from: '/protected/object-browser/buckets/$bucketId/upload/$' });
  const prefix = _splat ?? '';
  const { scope } = useBucketScope(bucketId);

  const close = useCallback(() => {
    void navigate({
      to: '/buckets/$bucketId/browse/$',
      params: { bucketId, _splat: prefix },
    });
  }, [navigate, bucketId, prefix]);

  return (
    <UploadDialog scope={scope} bucketId={bucketId} initialPrefix={prefix} onClose={close} />
  );
}
