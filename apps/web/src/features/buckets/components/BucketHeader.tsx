import type { Bucket, BucketDetail } from '@storage-io/contracts';
import { DatabaseIcon, GitBranchIcon, LockIcon, ShieldIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/app/Badge';
import { Bytes, Num } from '@/components/app/Format';
import { Meter } from '@/components/app/Meter';
import { ProviderMark } from '@/components/app/ProviderMark';
import { Skeleton } from '@/components/app/Skeleton';

/**
 * The bucket identity block at the top of both the settings page and the object
 * browser: name, the three protection badges, server, region, object count and
 * the quota meter. One component, because the two pages draw it identically in
 * the concept and a second copy drifts the moment one of them changes.
 */
export function BucketHeader({
  bucket,
  loading = false,
  actions,
}: {
  readonly bucket: Bucket | BucketDetail | undefined;
  readonly loading?: boolean;
  readonly actions?: ReactNode;
}) {
  const { t } = useTranslation('pages');
  const { t: tDomain } = useTranslation('domain');

  const quotaRatio =
    bucket?.quota == null || bucket.quota.limitBytes <= 0 || bucket.sizeBytes === null
      ? null
      : bucket.sizeBytes / bucket.quota.limitBytes;

  return (
    <div className="mb-(--gap) flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-lg border bg-card text-muted-foreground shadow-concept-sm">
          <DatabaseIcon aria-hidden="true" />
        </span>
        <div className="min-w-0">
          {loading || bucket === undefined ? (
            <Skeleton className="h-7 w-56" />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="ltr-isolate truncate font-mono text-[calc(var(--h1)-0.125rem)] font-semibold tracking-[-0.02em]">
                {bucket.name}
              </h1>
              {bucket.versioning === 'enabled' ? (
                <Badge variant="outline">
                  <GitBranchIcon aria-hidden="true" />
                  {t('buckets.flag.versioning')}
                </Badge>
              ) : null}
              {bucket.objectLock ? (
                <Badge variant="outline">
                  <LockIcon aria-hidden="true" />
                  {t('buckets.flag.objectLock')}
                </Badge>
              ) : null}
              <Badge variant="outline">
                <ShieldIcon aria-hidden="true" />
                {tDomain(`access.${bucket.access}`)}
              </Badge>
              {bucket.unavailable ? (
                <Badge variant="danger">{t('buckets.flag.unavailable')}</Badge>
              ) : null}
            </div>
          )}

          {loading || bucket === undefined ? (
            <Skeleton className="mt-2 h-4 w-72" />
          ) : (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <ProviderMark provider={bucket.provider} size="sm" />
                <span className="ltr-isolate font-mono">{bucket.serverName}</span>
              </span>
              {bucket.region === null ? null : (
                <span className="ltr-isolate font-mono">{bucket.region}</span>
              )}
              <span>
                <Num value={bucket.objects} compact /> {tDomain('unit.objects')}
              </span>
              {quotaRatio === null ? null : (
                <span className="flex min-w-48 items-center gap-2">
                  <Meter value={quotaRatio} className="w-20" label={bucket.name} />
                  <span className="num">
                    <Bytes value={bucket.sizeBytes} /> / <Bytes value={bucket.quota?.limitBytes ?? null} />
                  </span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
