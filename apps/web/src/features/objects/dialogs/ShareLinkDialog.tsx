import { PRESIGN_MAX_SECONDS } from '@storage-io/contracts';
import { LinkIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/app/Button';
import { CopyField } from '@/components/app/CopyField';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/app/Dialog';
import { DateTime } from '@/components/app/Format';
import { Label } from '@/components/app/Label';
import { OptionRow } from '@/components/app/FormRow';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Spinner } from '@/components/app/Spinner';
import { Switch } from '@/components/app/Switch';
import { toastProblem } from '@/lib/api/problems';
import type { BucketScope } from '@/lib/entities/resolve';
import { usePresignObject } from '../api';

/**
 * Share link for one object. It is answered and dismissed in place, so per
 * docs/ROUTES.md it is component state and has no URL.
 *
 * The link is a pre-signed URL from the API, signed with the server's own
 * credentials. It is generated on demand rather than on open: a signature has a
 * lifetime, and one created by opening a dialog and then left alone is a link that
 * expires before it is used.
 */
const HOUR_SECONDS = 3600;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const WEEK_SECONDS = Math.min(7 * DAY_SECONDS, PRESIGN_MAX_SECONDS);
type Expiry = 'hour' | 'day' | 'week';
interface SignedLink {
  readonly url: string;
  readonly expiresAt: string;
  /** The object, expiry and disposition this signature was made for. */
  readonly signature: string;
}

const EXPIRY_SECONDS: Readonly<Record<Expiry, number>> = {
  hour: HOUR_SECONDS,
  day: DAY_SECONDS,
  week: WEEK_SECONDS,
};

export interface ShareLinkDialogProps {
  readonly scope: BucketScope;
  readonly objectKey: string;
  readonly onClose: () => void;
}

/**
 * A presigned link for one object. It is answered and dismissed in place — there
 * is nothing to come back to — so per docs/ROUTES.md it has no URL of its own.
 */
function ShareLinkDialog({ scope, objectKey, onClose }: ShareLinkDialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const forceId = useId();

  const [expiry, setExpiry] = useState<Expiry>('day');
  const [forceDownload, setForceDownload] = useState(true);
  const [signed, setSigned] = useState<SignedLink | null>(null);
  const presign = usePresignObject(scope);

  // A signature belongs to the parameters it was made with, so a changed expiry or
  // disposition makes the held link stale — derived, not cleared by an effect.
  const signature = `${objectKey}:${expiry}:${String(forceDownload)}`;
  const link = signed?.signature === signature ? signed : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('browse.row.shareLink')}</DialogTitle>
          <DialogDescription className="ltr-isolate font-mono">
            {scope.bucket}/{objectKey}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label>{t('browse.inspector.expiresAfter')}</Label>
          <SegmentedControl
            options={[
              { value: 'hour', label: t('browse.inspector.hour') },
              { value: 'day', label: t('browse.inspector.day') },
              { value: 'week', label: t('browse.inspector.week') },
            ]}
            value={expiry}
            onValueChange={setExpiry}
            className="w-full"
            aria-label={t('browse.inspector.expiresAfter')}
          />
        </div>

        <div className="rounded-lg border px-(--card-pad)">
          <OptionRow
            label={<Label htmlFor={forceId}>{t('browse.inspector.forceDownload')}</Label>}
            hint={t('browse.inspector.forceDownloadHint')}
          >
            <Switch id={forceId} checked={forceDownload} onCheckedChange={setForceDownload} />
          </OptionRow>
        </div>

        {link === null ? null : (
          <div className="flex flex-col gap-2">
            <CopyField value={link.url} multiline label={t('browse.row.shareLink')} />
            <p className="text-[0.8125rem] text-muted-foreground">
              {t('browse.inspector.linkExpires')}{' '}
              <DateTime value={link.expiresAt} style="datetime" />
            </p>
          </div>
        )}

        <p className="text-[0.8125rem] text-muted-foreground">{t('browse.inspector.linkHint')}</p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tCommon('action.close')}
          </Button>
          <Button
            disabled={presign.isPending || objectKey === ''}
            onClick={() =>
              presign.mutate(
                {
                  key: objectKey,
                  expiresInSeconds: EXPIRY_SECONDS[expiry],
                  download: forceDownload,
                },
                {
                  onSuccess: (response) => setSigned({ ...response, signature }),
                  onError: (error) => toastProblem(error, tCommon),
                },
              )
            }
          >
            {presign.isPending ? <Spinner /> : <LinkIcon />}
            {t('browse.inspector.createLink')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { ShareLinkDialog };
