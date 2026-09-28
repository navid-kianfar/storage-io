import type { BucketAccessSettable, BucketRef } from '@storage-io/contracts';
import { Link } from '@tanstack/react-router';
import { GlobeIcon, LockIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/app/Alert';
import { Button } from '@/components/app/Button';
import { ChoiceCards, type ChoiceOption } from '@/components/app/ChoiceCards';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/app/Dialog';
import { Spinner } from '@/components/app/Spinner';
import { toastProblem } from '@/lib/api/problems';
import { useBucketBulkAction, useSaveBucketAccess } from '../api';
import { reportBulkResult } from './bulkResult';

/**
 * The access preset, from the bucket list's row menu and its bulk bar. A custom
 * policy is not a preset — that is the JSON editor on the bucket's own settings
 * page, which this dialog links to rather than duplicating.
 */
export function BucketAccessDialog({
  open,
  onOpenChange,
  buckets,
  initial,
  onSaved,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly buckets: readonly BucketRef[];
  readonly initial?: BucketAccessSettable;
  /** The route params for the "open the full editor" link, when there is one bucket. */
  readonly onSaved?: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const [access, setAccess] = useState<BucketAccessSettable>(initial ?? 'private');

  const single = useSaveBucketAccess();
  const bulk = useBucketBulkAction();
  const busy = single.isPending || bulk.isPending;
  const many = buckets.length > 1;

  const options: readonly ChoiceOption<BucketAccessSettable>[] = [
    {
      value: 'private',
      label: t('buckets.create.accessPrivate'),
      description: t('buckets.create.accessPrivateHint'),
      media: <LockIcon aria-hidden="true" />,
    },
    {
      value: 'public-read',
      label: t('buckets.create.accessPublic'),
      description: t('buckets.create.accessPublicHint'),
      media: <GlobeIcon aria-hidden="true" />,
    },
  ];

  function done(): void {
    onOpenChange(false);
    onSaved?.();
  }

  function submit(): void {
    if (busy) return;
    const failureTitle = t('buckets.accessDialog.failed');

    if (buckets.length === 1) {
      const ref = buckets[0]!;
      single.mutate(
        { ref: { serverId: ref.serverId, bucket: ref.bucket }, body: { access } },
        {
          onSuccess: () => {
            toast.success(t('buckets.accessDialog.saved'));
            done();
          },
          onError: (error) => toastProblem(error, tCommon, failureTitle),
        },
      );
      return;
    }

    bulk.mutate(
      { buckets: [...buckets], action: 'access', payload: { access } },
      {
        onSuccess: (response) => {
          reportBulkResult(response, t, 'buckets.bulk');
          done();
        },
        onError: (error) => toastProblem(error, tCommon, failureTitle),
      },
    );
  }

  const only = buckets.length === 1 ? buckets[0] : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('buckets.accessDialog.title')}</DialogTitle>
          <DialogDescription>{t('buckets.accessDialog.description')}</DialogDescription>
        </DialogHeader>

        <ChoiceCards
          options={options}
          value={access}
          onValueChange={setAccess}
          orientation="rows"
          aria-label={t('buckets.accessDialog.title')}
        />

        {access === 'public-read' ? (
          <Alert variant="warning">
            <AlertTitle>{t('bucket.access.publicWarning')}</AlertTitle>
            <AlertDescription>{t('bucket.access.publicWarningDetail')}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter className="sm:justify-between">
          {only === undefined || many ? (
            <span />
          ) : (
            <Button variant="ghost" size="sm" asChild>
              <Link
                to="/buckets/$server/$bucket"
                params={{ server: only.serverId, bucket: only.bucket }}
                hash="access"
              >
                {t('buckets.accessDialog.openSettings')}
              </Link>
            </Button>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {tCommon('action.cancel')}
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? <Spinner /> : null}
              {tCommon('action.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
