import { useNavigate, useParams } from '@tanstack/react-router';
import {
  DatabaseIcon,
  EraserIcon,
  FolderOpenIcon,
  GaugeIcon,
  GitBranchIcon,
  GlobeIcon,
  InfoIcon,
  RepeatIcon,
  ShieldCheckIcon,
  TimerIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WebhookIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/app/Button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/app/Card';
import { EmptyState } from '@/components/app/EmptyState';
import { OptionRow } from '@/components/app/FormRow';
import { PageHeader } from '@/components/app/PageHeader';
import { Separator } from '@/components/app/Separator';
import { useServerList } from '@/features/shell/api';
import { isApiError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';
import { s3Uri, useBucketDetail } from './api';
import { BucketHeader } from './components/BucketHeader';
import { useScrollSpy } from './components/useScrollSpy';
import { DeleteBucketDialog } from './dialogs/DeleteBucketDialog';
import { EmptyBucketDialog } from './dialogs/EmptyBucketDialog';
import { AccessSection } from './sections/AccessSection';
import { CorsSection } from './sections/CorsSection';
import { EventsSection } from './sections/EventsSection';
import { GeneralSection } from './sections/GeneralSection';
import { LifecycleSection } from './sections/LifecycleSection';
import { QuotaSection } from './sections/QuotaSection';
import { ReplicationSection } from './sections/ReplicationSection';
import { VersioningSection } from './sections/VersioningSection';

/**
 * `/buckets/$server/$bucket` — one page of sections rather than a tab strip, so
 * everything about a bucket can be read in one scroll and linked to by anchor
 * (`#lifecycle` from a toast, `#access` after creating a bucket with a custom
 * policy).
 *
 * The sub-nav follows the scroll with an IntersectionObserver rather than a scroll
 * handler, and clicking an entry scrolls rather than navigating: the hash is
 * written with `replace` so the Back button leaves the page instead of walking
 * back up the sections one at a time.
 */

const SECTION_IDS = [
  'general',
  'access',
  'quota',
  'versioning',
  'lifecycle',
  'replication',
  'events',
  'cors',
  'danger',
] as const;

type SectionId = (typeof SECTION_IDS)[number];

const SECTION_ICONS: Readonly<Record<SectionId, typeof InfoIcon>> = {
  general: InfoIcon,
  access: ShieldCheckIcon,
  quota: GaugeIcon,
  versioning: GitBranchIcon,
  lifecycle: TimerIcon,
  replication: RepeatIcon,
  events: WebhookIcon,
  cors: GlobeIcon,
  danger: TriangleAlertIcon,
};

export function BucketSettingsPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const params = useParams({ from: '/protected/buckets/$server/$bucket' });

  const bucketRef = useMemo(
    () => ({ serverId: params.server, bucket: params.bucket }),
    [params.server, params.bucket],
  );

  const servers = useServerList();
  const detail = useBucketDetail(bucketRef);
  const server = useMemo(
    () =>
      servers.data?.items.find(
        (item) => item.id === params.server || item.name === params.server,
      ),
    [servers.data, params.server],
  );

  const loading = detail.isLoading || servers.isLoading;
  const active = useScrollSpy(SECTION_IDS);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [emptyOpen, setEmptyOpen] = useState(false);

  /** Scrolls to a section without pushing a history entry per click. */
  const goTo = useCallback((id: SectionId) => {
    const element = document.getElementById(id);
    if (element === null) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', `#${id}`);
  }, []);

  // An incoming `#section` link has to wait for the sections to exist.
  useEffect(() => {
    if (loading) return;
    const hash = window.location.hash.slice(1);
    if (hash === '' || !(SECTION_IDS as readonly string[]).includes(hash)) return;
    const element = document.getElementById(hash);
    element?.scrollIntoView({ block: 'start' });
  }, [loading]);

  const notFound = isApiError(detail.error) && detail.error.is('NOT_FOUND');
  if (notFound) {
    return (
      <>
        <PageHeader title={t('bucket.title')} />
        <Card>
          <EmptyState
            icon={DatabaseIcon}
            title={t('bucket.notFound.title')}
            description={t('bucket.notFound.description')}
            action={
              <Button variant="outline" onClick={() => void navigate({ to: '/buckets' })}>
                {t('buckets.title')}
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  function copyUri(): void {
    const uri = s3Uri(bucketRef.bucket);
    void navigator.clipboard.writeText(uri).then(
      () => toast.success(tCommon('action.copied'), { description: uri }),
      () => toast.error(tCommon('action.copy'), { description: uri }),
    );
  }

  return (
    <>
      <BucketHeader
        bucket={detail.data}
        loading={loading}
        actions={
          <>
            <Button variant="outline" asChild>
              <a
                href={`/browse/${encodeURIComponent(params.server)}/${encodeURIComponent(params.bucket)}/`}
                onClick={(event) => {
                  event.preventDefault();
                  void navigate({
                    to: '/browse/$server/$bucket/$',
                    params: { server: params.server, bucket: params.bucket, _splat: '' },
                  });
                }}
              >
                <FolderOpenIcon />
                {t('bucket.browse')}
              </a>
            </Button>
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2Icon />
              {t('bucket.danger.deleteTitle')}
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-(--gap) lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-(--gap-lg)">
        <nav
          aria-label={t('bucket.nav.label')}
          className="no-scrollbar -mx-(--content-pad-inline) flex gap-1 overflow-x-auto px-(--content-pad-inline) lg:sticky lg:top-20 lg:mx-0 lg:flex-col lg:px-0"
        >
          {SECTION_IDS.map((id) => {
            const Icon = SECTION_ICONS[id];
            const isDanger = id === 'danger';
            return (
              <div key={id} className="contents">
                {isDanger ? <Separator className="my-1 hidden lg:block" /> : null}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-current={active === id ? 'true' : undefined}
                  onClick={() => goTo(id)}
                  className={cn(
                    'shrink-0 justify-start gap-2',
                    active === id && 'bg-accent text-accent-foreground',
                    isDanger && 'text-destructive hover:text-destructive',
                  )}
                >
                  <Icon />
                  {t(`bucket.nav.${id}`)}
                </Button>
              </div>
            );
          })}
        </nav>

        <div className="flex min-w-0 flex-col gap-(--gap-lg)">
          <GeneralSection
            bucketRef={bucketRef}
            bucket={detail.data}
            server={server}
            loading={loading}
            onCopyUri={copyUri}
          />
          <AccessSection bucketRef={bucketRef} server={server} loading={loading} />
          <QuotaSection bucketRef={bucketRef} server={server} loading={loading} />
          <VersioningSection
            bucketRef={bucketRef}
            bucket={detail.data}
            server={server}
            loading={loading}
          />
          <LifecycleSection bucketRef={bucketRef} server={server} loading={loading} />
          <ReplicationSection bucketRef={bucketRef} server={server} loading={loading} />
          <EventsSection bucketRef={bucketRef} server={server} loading={loading} />
          <CorsSection bucketRef={bucketRef} server={server} loading={loading} />

          <Card id="danger" className="scroll-mt-24 border-destructive/40">
            <CardHeader>
              <CardTitle className="text-destructive">{t('bucket.danger.title')}</CardTitle>
              <CardDescription>{t('bucket.danger.description')}</CardDescription>
            </CardHeader>
            <div className="px-(--card-pad) pb-1">
              <OptionRow
                label={t('bucket.danger.emptyTitle')}
                hint={t('bucket.danger.emptyHint')}
              >
                <Button variant="outline" onClick={() => setEmptyOpen(true)}>
                  <EraserIcon />
                  {t('bucket.danger.emptyTitle')}
                </Button>
              </OptionRow>
              <OptionRow
                label={t('bucket.danger.deleteTitle')}
                hint={t('bucket.danger.deleteHint')}
              >
                <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                  <Trash2Icon />
                  {t('bucket.danger.deleteTitle')}
                </Button>
              </OptionRow>
            </div>
          </Card>
        </div>
      </div>

      <DeleteBucketDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        buckets={[bucketRef]}
        objectCount={detail.data?.objects ?? null}
        onDeleted={() => void navigate({ to: '/buckets' })}
      />

      <EmptyBucketDialog
        open={emptyOpen}
        onOpenChange={setEmptyOpen}
        bucket={bucketRef}
        objectCount={detail.data?.objects ?? null}
        sizeBytes={detail.data?.sizeBytes ?? null}
      />
    </>
  );
}
