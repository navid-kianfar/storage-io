import { importObjectFromUrlRequestSchema } from '@storage-io/contracts';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
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
import { OptionRow } from '@/components/app/FormRow';
import { Spinner } from '@/components/app/Spinner';
import { Switch } from '@/components/app/Switch';
import { useSettings } from '@/features/shell/api';
import { toastProblem } from '@/lib/api/problems';
import { useBucketScope, type BucketScope } from '@/lib/entities/resolve';
import { useFormat } from '@/lib/format/FormatProvider';
import { useImportFromUrl } from '../api';

/**
 * Import from URL — the `/buckets/$bucketId/import/$` route over the object
 * browser.
 *
 * The API fetches the URL server-side and streams it into the bucket, so nothing
 * passes through this browser and a 4 GB import does not need a 4 GB tab. That is
 * also why this is not a transfer in the transfer panel: there is nothing for the
 * browser to do while it happens.
 *
 * The size ceiling is `Settings.transfers.importUrlMaxMb`, shown here so the limit
 * is visible before the request rather than in the error afterwards.
 */
const BYTES_IN_MB = 1_000_000;

/** One stable placeholder while the bucket id resolves. */
const EMPTY_SCOPE: BucketScope = { serverId: '', bucket: '' };

export interface ImportUrlDialogProps {
  /** The resolved bucket; `null` while its id is still resolving. */
  readonly scope: BucketScope | null;
  readonly prefix: string;
  readonly onClose: () => void;
}

function ImportUrlDialog({ scope: resolved, prefix, onClose }: ImportUrlDialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const format = useFormat();

  const scope = resolved ?? EMPTY_SCOPE;

  const settings = useSettings();
  const importUrl = useImportFromUrl(scope);

  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [keyEdited, setKeyEdited] = useState(false);

  const maxMb = settings.data?.transfers.importUrlMaxMb ?? null;
  const parsedUrl = importObjectFromUrlRequestSchema.shape.url.safeParse(url);
  const urlInvalid = url !== '' && !parsedUrl.success;
  const effectiveKey = key.trim() === '' ? '' : `${prefix}${key.trim()}`;
  const canSubmit =
    resolved !== null && parsedUrl.success && effectiveKey !== '' && !importUrl.isPending;

  /** A URL's last path segment is almost always the name the operator wants. */
  function suggestKey(next: string): void {
    if (keyEdited) return;
    try {
      const parsed = new URL(next);
      const name = parsed.pathname.split('/').filter((part) => part !== '').pop() ?? '';
      setKey(decodeURIComponent(name));
    } catch {
      // Not a URL yet; leave the key alone.
    }
  }

  function submit(): void {
    if (!canSubmit) return;
    importUrl.mutate(
      { url: url.trim(), key: effectiveKey, overwrite },
      {
        onSuccess: (object) => {
          toast.success(t('browse.importUrl.done', { key: object.key }));
          onClose();
        },
        onError: (error) => toastProblem(error, tCommon),
      },
    );
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
          <DialogTitle>{t('browse.importUrl.title')}</DialogTitle>
          <DialogDescription>{t('browse.importUrl.description')}</DialogDescription>
        </DialogHeader>

        <FormField label={t('browse.importUrl.url')}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                suggestKey(event.target.value);
              }}
              placeholder="https://example.com/file.zip"
              aria-invalid={urlInvalid}
              className="ltr-isolate font-mono"
            />
          )}
        </FormField>

        <FormField
          label={t('browse.importUrl.key')}
          hint={
            <span className="ltr-isolate font-mono break-all">
              {scope.bucket}/{effectiveKey}
            </span>
          }
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                setKeyEdited(true);
              }}
              className="ltr-isolate font-mono"
            />
          )}
        </FormField>

        <div className="rounded-lg border px-(--card-pad)">
          <OptionRow label={t('browse.importUrl.overwrite')}>
            <Switch
              checked={overwrite}
              onCheckedChange={setOverwrite}
              aria-label={t('browse.importUrl.overwrite')}
            />
          </OptionRow>
        </div>

        {maxMb === null ? null : (
          <p className="text-[0.8125rem] text-muted-foreground">
            {t('browse.importUrl.maxSize', { size: format.bytes(maxMb * BYTES_IN_MB) })}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importUrl.isPending}>
            {tCommon('action.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {importUrl.isPending ? <Spinner /> : null}
            {t('browse.importUrl.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { ImportUrlDialog };

/** `/buckets/$bucketId/import/$` — import-from-URL over the object browser. */
export function ImportUrlRoute() {
  const navigate = useNavigate();
  const { bucketId, _splat } = useParams({ from: '/protected/object-browser/buckets/$bucketId/import/$' });
  const prefix = _splat ?? '';
  const { scope } = useBucketScope(bucketId);

  const close = useCallback(() => {
    void navigate({
      to: '/buckets/$bucketId/browse/$',
      params: { bucketId, _splat: prefix },
    });
  }, [navigate, bucketId, prefix]);

  return <ImportUrlDialog scope={scope} prefix={prefix} onClose={close} />;
}
