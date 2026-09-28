import type { BucketDetail, Server } from '@storage-io/contracts';
import { CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/app/Button';
import { CardContent } from '@/components/app/Card';
import { Bytes, DateTime, Num } from '@/components/app/Format';
import { FormActions, FormRow } from '@/components/app/FormRow';
import { Spinner } from '@/components/app/Spinner';
import { TagEditor } from '@/components/app/TagEditor';
import { toastProblem } from '@/lib/api/problems';
import { useBucketTags, useSaveBucketTags, type BucketRefParams } from '../api';
import { SectionCard, sectionAvailability } from '../components/SectionCard';
import { DefinitionList } from './DefinitionList';

/**
 * General: everything about the bucket that cannot change, plus the one thing
 * that can — its tags. A bucket cannot be renamed and the page says so instead of
 * offering a field that would fail.
 *
 * The editable half is its own component, mounted with the saved tags as its
 * initial state and keyed by them. That is how a "server value, then a local draft"
 * form avoids an effect copying one into the other: when the server's answer
 * changes the form remounts with the new value, and while the operator is editing
 * nothing overwrites what they typed. Every editable section on this page is built
 * this way.
 */
export function GeneralSection({
  bucketRef,
  bucket,
  server,
  loading,
  onCopyUri,
}: {
  readonly bucketRef: BucketRefParams;
  readonly bucket: BucketDetail | undefined;
  readonly server: Server | undefined;
  readonly loading: boolean;
  readonly onCopyUri: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();

  const availability = sectionAvailability(server, 'tagging', loading);
  const tagsQuery = useBucketTags(bucketRef, availability === 'ready');
  const savedTags = tagsQuery.data?.tags;

  return (
    <SectionCard
      id="general"
      title={t('bucket.general.title')}
      description={t('bucket.general.description')}
      availability={loading ? 'loading' : 'ready'}
      provider={server?.provider}
      action={
        <Button variant="ghost" size="sm" onClick={onCopyUri}>
          <CopyIcon />
          {t('bucket.copyUri')}
        </Button>
      }
    >
      <CardContent>
        <DefinitionList
          rows={[
            { label: t('bucket.general.name'), value: bucket?.name ?? '—', mono: true },
            { label: t('bucket.general.server'), value: bucket?.serverName ?? '—', mono: true },
            { label: t('bucket.general.region'), value: bucket?.region ?? '—', mono: true },
            {
              label: t('bucket.general.created'),
              value: <DateTime value={bucket?.createdAt ?? null} style="date" />,
            },
            { label: t('bucket.general.objects'), value: <Num value={bucket?.objects ?? null} /> },
            { label: t('bucket.general.size'), value: <Bytes value={bucket?.sizeBytes ?? null} /> },
            {
              label: t('bucket.general.noncurrent'),
              value: <Num value={bucket?.noncurrentVersions ?? null} />,
            },
            {
              label: t('bucket.general.storageClass'),
              value: bucket?.defaultStorageClass ?? '—',
              mono: true,
            },
            { label: t('bucket.general.owner'), value: bucket?.owner ?? '—', mono: true },
          ]}
        />
        <p className="mt-4 text-[0.8125rem] text-muted-foreground">
          {t('bucket.general.renameHint')}
        </p>
      </CardContent>

      {availability === 'ready' && savedTags !== undefined ? (
        <TagsForm key={JSON.stringify(savedTags)} bucketRef={bucketRef} savedTags={savedTags} />
      ) : (
        <FormRow label={t('bucket.general.tags')} hint={t('bucket.general.tagsHint')}>
          <p className="text-[0.8125rem] text-muted-foreground">
            {availability === 'not_supported'
              ? tCommon('state.notSupported')
              : availability === 'offline'
                ? tCommon('state.unavailable')
                : tCommon('state.loading')}
          </p>
        </FormRow>
      )}
    </SectionCard>
  );
}

function TagsForm({
  bucketRef,
  savedTags,
}: {
  readonly bucketRef: BucketRefParams;
  readonly savedTags: Readonly<Record<string, string>>;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const save = useSaveBucketTags();
  const [tags, setTags] = useState<Readonly<Record<string, string>>>(savedTags);

  const dirty = JSON.stringify(tags) !== JSON.stringify(savedTags);

  function submit(): void {
    save.mutate(
      { ref: bucketRef, body: { tags } },
      {
        onSuccess: () => toast.success(t('bucket.general.saved')),
        onError: (error) => toastProblem(error, tCommon, t('bucket.general.saved')),
      },
    );
  }

  return (
    <>
      <FormRow label={t('bucket.general.tags')} hint={t('bucket.general.tagsHint')}>
        <TagEditor tags={tags} onTagsChange={setTags} disabled={save.isPending} />
      </FormRow>

      {dirty ? (
        <FormActions>
          <Button
            variant="outline"
            onClick={() => {
              setTags(savedTags);
              toast.info(t('bucket.discard'));
            }}
            disabled={save.isPending}
          >
            {tCommon('action.cancel')}
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            {tCommon('action.save')}
          </Button>
        </FormActions>
      ) : null}
    </>
  );
}
