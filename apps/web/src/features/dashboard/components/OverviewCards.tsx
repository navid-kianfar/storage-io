import type { AccessKey, ActivityEvent, Dashboard, Job } from '@storage-io/contracts';
import { Link } from '@tanstack/react-router';
import {
  ActivityIcon,
  ArrowRightIcon,
  CircleCheckIcon,
  DatabaseIcon,
  FolderPlusIcon,
  KeyRoundIcon,
  LayersIcon,
  ShieldCheckIcon,
  UploadIcon,
} from 'lucide-react';
import { Suspense, lazy, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Bytes,
  Button,
  Duration,
  EmptyState,
  JobStatusBadge,
  Kbd,
  ListRow,
  Meter,
  Num,
  Pct,
  RelativeTime,
  SectionCard,
  Skeleton,
  Tile,
} from '@/components/app';
import type { DonutSlice } from '@/features/dashboard/components/StorageDonut';
import { useDialogs } from '@/lib/dialogs/useDialogs';

const StorageDonut = lazy(() => import('@/features/dashboard/components/StorageDonut'));

/** The dashboard's smaller cards. The two tables live in `OverviewTables.tsx`. */

/* ------------------------------ bulk jobs ------------------------------ */

export function ActiveJobsCard({
  jobs,
  loading,
}: {
  readonly jobs: readonly Job[];
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();

  const running = jobs.filter((job) => job.status === 'running').length;
  const paused = jobs.filter((job) => job.status === 'paused').length;

  return (
    <SectionCard
      title={t('overview.jobs.title')}
      description={
        loading ? (
          <Skeleton className="h-3 w-28" />
        ) : (
          t('overview.jobs.summary', { running, paused })
        )
      }
      action={
        <Button variant="ghost" size="sm" asChild>
          <Link to="/jobs">
            {tCommon('action.viewAll')}
            <ArrowRightIcon className="flip-rtl" />
          </Link>
        </Button>
      }
    >
      {loading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={LayersIcon}
          title={t('overview.jobs.emptyTitle')}
          description={t('overview.jobs.emptyDescription')}
          className="py-6"
        />
      ) : (
        <div className="flex flex-col gap-4">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function JobRow({ job }: { readonly job: Job }) {
  const { t } = useTranslation('pages');
  const { t: tDomain } = useTranslation('domain');

  const { total, processed } = job.progress;
  const ratio = total === null || total === 0 ? null : processed / total;
  // `media-prod` + `raw/` reads as one word without the separator the operator
  // sees everywhere else a bucket and a prefix are shown together.
  const prefix = job.source.filters.prefix;
  const route = prefix.length === 0 ? job.source.bucket : `${job.source.bucket}/${prefix}`;
  const destination =
    job.target === null ? null : `${job.target.serverName}/${job.target.bucket}`;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <Link
          to="/jobs"
          search={{ job: job.id }}
          className="truncate text-[0.8125rem] font-medium hover:underline"
        >
          {job.name.length > 0 ? job.name : tDomain(`jobType.${job.type}`)}
        </Link>
        <JobStatusBadge status={job.status} />
      </div>
      <div className="ltr-isolate truncate font-mono text-xs text-muted-foreground">
        {route}
        {destination === null ? null : ` → ${destination}`}
      </div>
      <Meter
        value={ratio}
        tone={job.status === 'paused' ? 'warn' : 'default'}
        striped={job.status === 'running'}
        label={t('overview.jobs.progress', { name: job.name })}
      />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="num">
          <Num value={processed} compact /> {total === null ? null : <>/ <Num value={total} compact /></>}
        </span>
        {job.waitingFor === null ? (
          job.progress.etaSeconds === null ? (
            <Pct value={ratio} />
          ) : (
            <span>
              {t('overview.jobs.eta')} <Duration seconds={job.progress.etaSeconds} />
            </span>
          )
        ) : (
          <span>
            {t('overview.jobs.waitingFor')} <span className="font-mono">{job.waitingFor}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/* --------------------------- storage breakdown --------------------------- */

const SLICE_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

export function StorageByServerCard({
  byServer,
  loading,
}: {
  readonly byServer: Dashboard['byServer'];
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');

  // The denominator is the sum of what the servers report, not
  // `Dashboard.totals.usedBytes`. The two measure different things — the totals
  // are the bucket cache, `byServer.usedBytes` is the server's own used capacity
  // — and dividing one by the other produced a 177,746,144% share against the
  // real API.
  const totalBytes = useMemo(
    () => byServer.reduce((sum, entry) => sum + entry.usedBytes, 0),
    [byServer],
  );

  const slices = useMemo<readonly DonutSlice[]>(() => {
    const sorted = [...byServer].sort((left, right) => right.usedBytes - left.usedBytes);
    const head = sorted.slice(0, SLICE_COLORS.length);
    const tail = sorted.slice(SLICE_COLORS.length);
    const rows: DonutSlice[] = head.map((entry, index) => ({
      key: entry.serverId,
      label: entry.name,
      value: entry.usedBytes,
      color: SLICE_COLORS[index]!,
    }));
    if (tail.length > 0) {
      rows.push({
        key: 'other',
        label: t('overview.breakdown.other', { count: tail.length }),
        value: tail.reduce((sum, entry) => sum + entry.usedBytes, 0),
        color: 'var(--muted-foreground)',
      });
    }
    return rows;
  }, [byServer, t]);

  return (
    <SectionCard title={t('overview.breakdown.title')} description={t('overview.breakdown.description')}>
      {loading ? (
        <div className="flex items-center gap-6">
          <Skeleton className="size-40 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ) : slices.length === 0 || totalBytes === 0 ? (
        // Every server reporting zero draws as a blank ring with "0 B" in it,
        // which reads as a broken chart rather than as a fresh install.
        <EmptyState icon={DatabaseIcon} title={t('overview.breakdown.emptyTitle')} className="py-6" />
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          <div className="relative">
            <Suspense fallback={<Skeleton className="size-40 rounded-full" />}>
              <StorageDonut slices={slices} ariaLabel={t('overview.breakdown.title')} />
            </Suspense>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <b className="num text-sm">
                <Bytes value={totalBytes} />
              </b>
              <span className="text-xs text-muted-foreground">
                {t('overview.breakdown.total')}
              </span>
            </div>
          </div>
          <dl className="flex min-w-40 flex-1 flex-col gap-2.5 text-[0.8125rem]">
            {slices.map((slice) => (
              <div key={slice.key} className="flex items-center justify-between gap-3">
                <dt className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ background: slice.color }}
                  />
                  <span className="truncate font-mono">{slice.label}</span>
                </dt>
                <dd className="num shrink-0 text-muted-foreground">
                  <Pct value={totalBytes === 0 ? null : slice.value / totalBytes} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </SectionCard>
  );
}

/* ---------------------------- quick actions ---------------------------- */

export function QuickActionsCard() {
  const { t } = useTranslation('pages');
  const dialogs = useDialogs();

  return (
    <SectionCard
      title={t('overview.quick.title')}
      description={
        <span className="flex items-center gap-1">
          {t('overview.quick.description')} <Kbd>⌘K</Kbd>
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        <Tile
          icon={UploadIcon}
          label={t('overview.quick.upload')}
          onClick={() => dialogs.open('upload')}
        />
        <Tile
          icon={FolderPlusIcon}
          label={t('overview.quick.createBucket')}
          onClick={() => dialogs.open('create-bucket')}
        />
        <Tile
          icon={KeyRoundIcon}
          label={t('overview.quick.createKey')}
          onClick={() => dialogs.open('create-access-key')}
        />
        <Tile
          icon={LayersIcon}
          label={t('overview.quick.startJob')}
          onClick={() => dialogs.open('new-job')}
        />
      </div>
    </SectionCard>
  );
}

/* --------------------------- expiring keys ---------------------------- */

const EXPIRING_SOON_DAYS = 7;
const DAY_MS = 86_400_000;

export function ExpiringKeysCard({
  keys,
  loading,
}: {
  readonly keys: readonly AccessKey[];
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');

  return (
    <SectionCard
      title={t('overview.keys.title')}
      description={t('overview.keys.description')}
      action={
        <Button variant="ghost" size="sm" asChild>
          <Link to="/keys">{t('overview.keys.allKeys')}</Link>
        </Button>
      }
      flush
    >
      {loading ? (
        <div className="flex flex-col gap-2 p-(--card-pad)">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : keys.length === 0 ? (
        <EmptyState
          icon={KeyRoundIcon}
          title={t('overview.keys.emptyTitle')}
          description={t('overview.keys.emptyDescription')}
          className="py-6"
        />
      ) : (
        keys.map((key) => <ExpiringKeyRow key={`${key.serverId}/${key.accessKeyId}`} item={key} />)
      )}
    </SectionCard>
  );
}

function ExpiringKeyRow({ item }: { readonly item: AccessKey }) {
  // Frozen at mount rather than read during render: "now" must not change between
  // two renders of the same row, or the badge's tone would flicker.
  const [now] = useState(() => Date.now());
  const soon =
    item.expiresAt !== null && Date.parse(item.expiresAt) - now < EXPIRING_SOON_DAYS * DAY_MS;

  return (
    <ListRow
      media={
        <KeyRoundIcon
          className={soon ? 'size-4 text-warning' : 'size-4 text-muted-foreground'}
          aria-hidden="true"
        />
      }
      title={item.name ?? item.userName}
      subtitle={<span className="ltr-isolate font-mono">{item.accessKeyId}</span>}
      trailing={
        item.expiresAt === null ? null : (
          <Badge variant={soon ? 'warning' : 'outline'}>
            <RelativeTime value={item.expiresAt} />
          </Badge>
        )
      }
    />
  );
}

/* -------------------------- recent activity --------------------------- */

const ACTIVITY_ICONS = {
  objects: UploadIcon,
  buckets: DatabaseIcon,
  access: KeyRoundIcon,
  servers: ActivityIcon,
  jobs: LayersIcon,
  system: ActivityIcon,
  auth: ShieldCheckIcon,
} as const;

const RESULT_TONES = {
  success: 'text-success',
  failure: 'text-destructive',
  warning: 'text-warning',
} as const;

export function RecentActivityCard({
  events,
  loading,
}: {
  readonly events: readonly ActivityEvent[];
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');

  return (
    <SectionCard
      title={t('overview.activity.title')}
      description={t('overview.activity.description')}
      action={
        <Button variant="ghost" size="sm" asChild>
          <Link to="/activity">{t('overview.activity.viewLog')}</Link>
        </Button>
      }
      flush
    >
      {loading ? (
        <div className="flex flex-col gap-2 p-(--card-pad)">
          {Array.from({ length: 4 }, (_unused, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={CircleCheckIcon}
          title={t('overview.activity.emptyTitle')}
          className="py-6"
        />
      ) : (
        events.map((event) => <ActivityRow key={event.id} event={event} />)
      )}
    </SectionCard>
  );
}

function ActivityRow({ event }: { readonly event: ActivityEvent }) {
  const Icon = ACTIVITY_ICONS[event.category];
  return (
    <ListRow
      media={<Icon className={`size-4 ${RESULT_TONES[event.result]}`} aria-hidden="true" />}
      title={event.title}
      subtitle={
        <span className="font-mono">
          {event.target ?? ''}
          {event.target !== null && event.serverName !== null ? ' · ' : ''}
          {event.serverName ?? ''}
        </span>
      }
      trailing={<RelativeTime value={event.at} className="text-muted-foreground" />}
    />
  );
}
