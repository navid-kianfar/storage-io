import type { Bucket } from '@storage-io/contracts';
import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { BracesIcon, DatabaseIcon, GitBranchIcon, GlobeIcon, LockIcon } from 'lucide-react';
import { Badge } from '@/components/app/Badge';
import { Bytes, DateTime, Num } from '@/components/app/Format';
import { Meter, meterToneFor } from '@/components/app/Meter';
import { ProviderMark } from '@/components/app/ProviderMark';
import { cn } from '@/lib/utils';

/**
 * The bucket table's columns. Kept beside the page rather than inside it so the
 * CSV export names the same fields, and so the page component stays about state
 * and requests.
 *
 * Nothing here sorts: the concept sorts from a control in the toolbar
 * (`?sort=size|name|quota|written`, four server-side orders), and clickable
 * headers on a paginated list would promise an ordering the API does not offer.
 */

export function quotaRatio(bucket: Bucket): number | null {
  if (bucket.quota === null || bucket.quota.limitBytes <= 0) return null;
  if (bucket.sizeBytes === null) return null;
  return bucket.sizeBytes / bucket.quota.limitBytes;
}

const ACCESS_VARIANT: Readonly<Record<Bucket['access'], 'outline' | 'warning' | 'info'>> = {
  private: 'outline',
  'public-read': 'warning',
  custom: 'info',
};

const ACCESS_ICON = {
  private: LockIcon,
  'public-read': GlobeIcon,
  custom: BracesIcon,
} as const;

export function AccessBadge({
  access,
  label,
}: {
  readonly access: Bucket['access'];
  readonly label: string;
}) {
  const Icon = ACCESS_ICON[access];
  return (
    <Badge variant={ACCESS_VARIANT[access]}>
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  );
}

export interface BucketColumnOptions {
  /** `t` bound to the `pages` namespace. */
  readonly t: TFunction;
  /** `t` bound to the `domain` namespace, for access and versioning labels. */
  readonly tDomain: TFunction;
  /** `t` bound to the default namespace, for "No quota". */
  readonly tCommon: TFunction;
}

export function bucketColumns({
  t,
  tDomain,
  tCommon,
}: BucketColumnOptions): readonly ColumnDef<Bucket, unknown>[] {
  return [
    {
      id: 'name',
      header: t('buckets.column.bucket'),
      enableSorting: false,
      enableHiding: false,
      cell: ({ row }) => {
        const bucket = row.original;
        return (
          <div className="flex min-w-0 items-center gap-2">
            <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Link
              to="/buckets/$bucketId"
              params={{ bucketId: bucket.id }}
              onClick={(event) => event.stopPropagation()}
              className="ltr-isolate truncate font-mono text-sm font-medium hover:underline"
            >
              {bucket.name}
            </Link>
            {bucket.versioning === 'enabled' ? (
              <GitBranchIcon
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-label={t('buckets.flag.versioning')}
              />
            ) : null}
            {bucket.objectLock ? (
              <LockIcon
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-label={t('buckets.flag.objectLock')}
              />
            ) : null}
            {bucket.unavailable ? (
              <Badge variant="danger">{t('buckets.flag.unavailable')}</Badge>
            ) : null}
          </div>
        );
      },
    },
    {
      id: 'server',
      header: t('buckets.column.server'),
      enableSorting: false,
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5">
          <ProviderMark provider={row.original.provider} size="sm" />
          <span className="ltr-isolate truncate font-mono text-[0.8125rem] text-muted-foreground">
            {row.original.serverName}
          </span>
        </span>
      ),
    },
    {
      id: 'objects',
      header: t('buckets.column.objects'),
      enableSorting: false,
      cell: ({ row }) => <Num value={row.original.objects} compact />,
    },
    {
      id: 'size',
      header: t('buckets.column.size'),
      enableSorting: false,
      cell: ({ row }) => <Bytes value={row.original.sizeBytes} />,
    },
    {
      id: 'quota',
      header: t('buckets.column.quota'),
      size: 180,
      enableSorting: false,
      cell: ({ row }) => {
        const ratio = quotaRatio(row.original);
        if (ratio === null) {
          return <span className="text-xs text-muted-foreground">{tCommon('meter.noQuota')}</span>;
        }
        const tone = meterToneFor(ratio);
        const percent = Math.round(ratio * 100);
        return (
          <div className="flex items-center gap-2">
            <Meter value={ratio} className="min-w-16 grow" label={row.original.name} />
            <span
              className={cn(
                'num text-xs',
                tone === 'crit' ? 'text-destructive-foreground' : 'text-muted-foreground',
              )}
            >
              {percent}%
            </span>
          </div>
        );
      },
    },
    {
      id: 'access',
      header: t('buckets.column.access'),
      enableSorting: false,
      cell: ({ row }) => (
        <AccessBadge
          access={row.original.access}
          label={tDomain(`access.${row.original.access}`)}
        />
      ),
    },
    {
      id: 'created',
      header: t('buckets.column.created'),
      enableSorting: false,
      cell: ({ row }) => (
        <DateTime
          value={row.original.createdAt}
          style="date"
          className="text-[0.8125rem] text-muted-foreground"
        />
      ),
    },
    {
      id: 'region',
      header: t('buckets.column.region'),
      enableSorting: false,
      cell: ({ row }) => (
        <span className="ltr-isolate font-mono text-[0.8125rem] text-muted-foreground">
          {row.original.region ?? '—'}
        </span>
      ),
    },
    {
      id: 'versioning',
      header: t('buckets.column.versioning'),
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-[0.8125rem] text-muted-foreground">
          {tDomain(`versioning.${row.original.versioning}`)}
        </span>
      ),
    },
  ];
}

/** Columns hidden until the operator asks for them, as the concept's menu shows. */
export const BUCKET_HIDDEN_COLUMNS: Readonly<Record<string, boolean>> = {
  region: false,
  versioning: false,
};
