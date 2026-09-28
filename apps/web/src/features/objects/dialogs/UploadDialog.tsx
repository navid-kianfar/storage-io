import { useMemo, useState } from 'react';
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
import { Label } from '@/components/app/Label';
import { OptionRow } from '@/components/app/FormRow';
import { Switch } from '@/components/app/Switch';
import { TagEditor } from '@/components/app/TagEditor';
import { useBucketDetail, useBucketQuota } from '@/features/buckets/api';
import { useServerList } from '@/features/shell/api';
import { enqueueUploads } from '@/features/transfers/engine';
import { registerDialog, type DialogProps } from '@/lib/dialogs/registry';
import { useFormat } from '@/lib/format/FormatProvider';
import { guessContentType } from '../fileKind';

/**
 * Upload — `?dialog=upload`, with `d_server`, `d_bucket` and `d_prefix` from the
 * object browser (or typed in when the dialog is opened from the palette).
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

function UploadDialog({ params, onClose }: DialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const format = useFormat();

  const serverParam = params.server ?? '';
  const bucketParam = params.bucket ?? '';
  const prefixId = 'upload-prefix';

  const servers = useServerList();
  const [serverId, setServerId] = useState<string | null>(serverParam === '' ? null : serverParam);
  const [bucket, setBucket] = useState(bucketParam);
  const [prefix, setPrefix] = useState(params.prefix ?? '');
  const [files, setFiles] = useState<readonly DroppedFile[]>([]);
  const [storageClass, setStorageClass] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [detectType, setDetectType] = useState(true);
  const [showExtras, setShowExtras] = useState(false);
  const [metadata, setMetadata] = useState<Readonly<Record<string, string>>>({});
  const [tags, setTags] = useState<Readonly<Record<string, string>>>({});

  const scopeReady = serverId !== null && bucket !== '';
  const bucketRef = useMemo(
    () => ({ serverId: serverId ?? '', bucket }),
    [serverId, bucket],
  );
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

  const serverOptions = useMemo(
    () =>
      (servers.data?.items ?? []).map((server) => ({
        value: server.id,
        label: server.name,
        disabled: server.status === 'offline',
      })),
    [servers.data],
  );

  const serverName =
    servers.data?.items.find((item) => item.id === serverId || item.name === serverId)?.name ??
    serverId ??
    '';

  const normalizedPrefix = prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`;
  const canSubmit = scopeReady && files.length > 0 && !overQuota;

  function submit(): void {
    if (!canSubmit || serverId === null) return;
    enqueueUploads({
      scope: { serverId, serverName, bucket },
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
            {t('browse.upload.title', { bucket: bucket === '' ? tCommon('action.select') : bucket })}
          </DialogTitle>
          <DialogDescription>{t('browse.upload.description')}</DialogDescription>
        </DialogHeader>

        {bucketParam === '' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('browse.copy.server')}</span>
              <Combobox
                options={serverOptions}
                value={serverId}
                onValueChange={setServerId}
                placeholder={tCommon('form.comboboxPlaceholder')}
                aria-label={t('browse.copy.server')}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="upload-bucket">{t('browse.copy.bucket')}</Label>
              <Input
                id="upload-bucket"
                value={bucket}
                onChange={(event) => setBucket(event.target.value)}
                className="ltr-isolate font-mono"
              />
            </div>
          </div>
        ) : null}

        <FileDropzone
          files={files}
          onFilesChange={setFiles}
          allowFolders
          multiple
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={prefixId}>{t('browse.upload.prefix')}</Label>
            <Input
              id={prefixId}
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              placeholder="2026/09/"
              className="ltr-isolate font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t('browse.upload.storageClass')}</span>
            <Combobox
              options={STORAGE_CLASSES.map((name) => ({ value: name, label: name }))}
              value={storageClass}
              onValueChange={setStorageClass}
              placeholder={detail.data?.defaultStorageClass ?? 'STANDARD'}
              clearable
              aria-label={t('browse.upload.storageClass')}
            />
          </div>
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
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('browse.metadataDialog.custom')}</span>
              <TagEditor
                tags={metadata}
                onTagsChange={setMetadata}
                hint={t('browse.metadataDialog.customHint')}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('browse.inspector.tabs.tags')}</span>
              <TagEditor tags={tags} onTagsChange={setTags} />
            </div>
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

registerDialog('upload', UploadDialog);

export { UploadDialog };
