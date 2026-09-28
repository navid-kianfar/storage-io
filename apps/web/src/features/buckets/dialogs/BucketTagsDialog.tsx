import type { BucketRef } from '@storage-io/contracts';
import { useState } from 'react';
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
import { Spinner } from '@/components/app/Spinner';
import { TagEditor } from '@/components/app/TagEditor';
import { toastProblem } from '@/lib/api/problems';
import { useBucketBulkAction, useBucketTags, useSaveBucketTags } from '../api';
import { reportBulkResult } from './bulkResult';

/**
 * Edit tags on one bucket or on a selection. `PUT …/tags` replaces the whole set
 * (that is what S3 does), so the dialog says so before it is used on many buckets
 * at once.
 */
export function BucketTagsDialog({
  open,
  onOpenChange,
  buckets,
  initial,
  onSaved,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly buckets: readonly BucketRef[];
  readonly initial?: Readonly<Record<string, string>>;
  readonly onSaved?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <BucketTagsDialogLoader
          buckets={buckets}
          initial={initial}
          onDone={() => {
            onOpenChange(false);
            onSaved?.();
          }}
        />
      ) : null}
    </Dialog>
  );
}

/**
 * Seeds the editor with the bucket's own tags when there is exactly one target.
 *
 * `PUT …/tags` replaces the whole set, and the bucket rows the list renders carry
 * no tags, so opening this straight from the list used to show an empty editor
 * for a bucket that already had tags — and saving one new pair silently dropped
 * every existing one. Editing many at once still starts empty, because there is
 * no single "current" set to show and the replace warning covers it.
 */
function BucketTagsDialogLoader({
  buckets,
  initial,
  onDone,
}: {
  readonly buckets: readonly BucketRef[];
  readonly initial?: Readonly<Record<string, string>>;
  readonly onDone: () => void;
}) {
  const only = buckets.length === 1 ? buckets[0] : undefined;
  const needsFetch = only !== undefined && initial === undefined;
  const ref = { serverId: only?.serverId ?? '', bucket: only?.bucket ?? '' };
  const current = useBucketTags(ref, needsFetch);

  if (needsFetch && current.isPending) {
    return (
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="sr-only">Loading</DialogTitle>
        </DialogHeader>
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      </DialogContent>
    );
  }

  const loaded = needsFetch ? (current.data?.tags ?? {}) : (initial ?? {});
  return <BucketTagsDialogBody buckets={buckets} initial={loaded} onDone={onDone} />;
}

function BucketTagsDialogBody({
  buckets,
  initial,
  onDone,
}: {
  readonly buckets: readonly BucketRef[];
  readonly initial: Readonly<Record<string, string>>;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const [tags, setTags] = useState<Readonly<Record<string, string>>>(initial);

  const single = useSaveBucketTags();
  const bulk = useBucketBulkAction();
  const busy = single.isPending || bulk.isPending;
  const many = buckets.length > 1;

  function submit(): void {
    if (busy) return;
    const failureTitle = t('buckets.tagsDialog.failed');

    if (buckets.length === 1) {
      const ref = buckets[0]!;
      single.mutate(
        { ref: { serverId: ref.serverId, bucket: ref.bucket }, body: { tags } },
        {
          onSuccess: () => {
            toast.success(t('buckets.tagsDialog.saved'));
            onDone();
          },
          onError: (error) => toastProblem(error, tCommon, failureTitle),
        },
      );
      return;
    }

    bulk.mutate(
      { buckets: [...buckets], action: 'tags', payload: { tags } },
      {
        onSuccess: (response) => {
          reportBulkResult(response, t, 'buckets.bulk');
          onDone();
        },
        onError: (error) => toastProblem(error, tCommon, failureTitle),
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {many
            ? t('buckets.tagsDialog.titleMany', { count: buckets.length })
            : t('buckets.tagsDialog.title')}
        </DialogTitle>
        <DialogDescription>{t('bucket.general.tagsHint')}</DialogDescription>
      </DialogHeader>

      {many ? (
        <Alert variant="warning">
          <AlertDescription>{t('buckets.tagsDialog.replaceWarning')}</AlertDescription>
        </Alert>
      ) : null}

      <TagEditor tags={tags} onTagsChange={setTags} disabled={busy} />

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={busy}>
          {tCommon('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={busy}>
          {busy ? <Spinner /> : null}
          {tCommon('action.save')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
