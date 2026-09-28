import { useNavigate } from '@tanstack/react-router';
import {
  ClockIcon,
  DatabaseIcon,
  FolderOpenIcon,
  HardDriveIcon,
  PlusIcon,
  UploadIcon,
  XIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Bytes,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Combobox,
  EmptyState,
  FormField,
  PageHeader,
  ProviderMark,
  Skeleton,
  type ComboboxOption,
} from '@/components/app';
import { useBuckets } from '@/features/buckets/api';
import { useServerList } from '@/features/shell/api';
import { useApiError } from '@/lib/api/useApiError';
import { useRecentBuckets } from '@/stores/recentBuckets';

/**
 * The dialogs `/browse` owns. Importing them here is what lets the palette open
 * them from any route: `DIALOG_OWNERS` sends the URL to /browse, and this module
 * is what registers the components the URL then names.
 */
import './dialogs/ImportUrlDialog';
import './dialogs/NewFolderDialog';
import './dialogs/ShareLinkDialog';
import './dialogs/UploadDialog';

/**
 * `/browse` with no bucket in the path.
 *
 * The object browser needs a server and a bucket; this is where they are chosen.
 * It matters for more than navigation: `upload`, `import-url`, `new-folder` and
 * `share-link` are owned by `/browse` in the dialog registry, so the command
 * palette sends the operator here from anywhere in the app. Importing those four
 * modules below is what registers them — without it the URL would name a dialog
 * that has no component.
 *
 * Recent buckets come from this browser, not the API: which bucket someone keeps
 * returning to is a habit, and the API has nowhere to keep it.
 */

/** One page is plenty to pick from; the search box narrows it further. */
const BUCKET_PAGE_SIZE = 500;

export function BucketPickerPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const apiError = useApiError();

  const servers = useServerList();
  const buckets = useBuckets({ sort: 'name', page: 1, pageSize: BUCKET_PAGE_SIZE });

  const recent = useRecentBuckets((state) => state.items);
  const forget = useRecentBuckets((state) => state.forget);

  const [chosenServerId, setServerId] = useState<string | null>(null);
  // The chosen bucket is its opaque id, not its name: that is what the browse
  // route takes, and a name is unique only within one server.
  const [chosenBucket, setBucket] = useState<string | null>(null);

  const serverItems = useMemo(() => servers.data?.items ?? [], [servers.data]);
  const bucketItems = useMemo(() => buckets.data?.items ?? [], [buckets.data]);

  /** With one server there is nothing to choose, so it is chosen. */
  const onlyServerId = serverItems.length === 1 ? (serverItems[0]?.id ?? null) : null;
  const serverId = chosenServerId ?? onlyServerId;

  const serverOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      serverItems.map((server) => ({
        value: server.id,
        label: server.name,
        description: server.endpoint,
        disabled: server.status === 'offline',
      })),
    [serverItems],
  );

  const bucketOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      bucketItems
        .filter((item) => serverId === null || item.serverId === serverId)
        .map((item) => ({
          value: item.id,
          label: item.name,
          description: item.serverName,
        })),
    [bucketItems, serverId],
  );

  // A bucket chosen on one server does not exist on the next one, so the choice is
  // derived rather than corrected after the fact by an effect.
  const bucket =
    chosenBucket !== null && bucketOptions.some((option) => option.value === chosenBucket)
      ? chosenBucket
      : null;

  const chosenServer = serverItems.find((server) => server.id === serverId);
  const canBrowse = chosenServer !== undefined && bucket !== null;

  function browse(targetBucketId: string): void {
    void navigate({
      to: '/buckets/$bucketId/browse/$',
      params: { bucketId: targetBucketId, _splat: '' },
    });
  }

  const loading = servers.isLoading || buckets.isLoading;
  const error = servers.error ?? buckets.error;
  const noServers = !loading && serverItems.length === 0;
  const noBuckets = !loading && serverItems.length > 0 && bucketItems.length === 0;

  return (
    <>
      <div className="hero-glow" />
      <PageHeader
        title={t('browse.title')}
        description={t('browse.picker.description')}
        actions={
          <Button variant="outline" onClick={() => void navigate({ to: '/buckets/new' })}>
            <PlusIcon />
            {t('buckets.create.title')}
          </Button>
        }
      />

      {error === null ? null : (
        <EmptyState
          icon={DatabaseIcon}
          title={tCommon('state.error')}
          description={apiError.message(error)}
        />
      )}

      {error !== null ? null : noServers ? (
        <EmptyState
          icon={HardDriveIcon}
          title={t('browse.picker.noServers')}
          description={t('browse.picker.noServersHint')}
          action={
            <Button onClick={() => void navigate({ to: '/servers/new' })}>
              <PlusIcon />
              {t('servers.add')}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-(--gap-lg) lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('browse.picker.title')}</CardTitle>
              <CardDescription>{t('browse.picker.hint')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FormField label={t('browse.picker.server')}>
                {({ id }) =>
                  loading ? (
                    <Skeleton className="h-(--control-h) w-full" />
                  ) : (
                    <Combobox
                      id={id}
                      options={serverOptions}
                      value={serverId}
                      onValueChange={setServerId}
                      placeholder={tCommon('form.comboboxPlaceholder')}
                      aria-label={t('browse.picker.server')}
                    />
                  )
                }
              </FormField>

              <FormField label={t('browse.picker.bucket')}>
                {({ id }) =>
                  loading ? (
                    <Skeleton className="h-(--control-h) w-full" />
                  ) : (
                    <Combobox
                      id={id}
                      options={bucketOptions}
                      value={bucket}
                      onValueChange={setBucket}
                      placeholder={tCommon('form.comboboxPlaceholder')}
                      emptyMessage={t('browse.picker.noBucketsOnServer')}
                      disabled={serverId === null}
                      aria-label={t('browse.picker.bucket')}
                    />
                  )
                }
              </FormField>

              {noBuckets ? (
                <p className="text-[0.8125rem] text-muted-foreground">
                  {t('browse.picker.noBuckets')}
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!canBrowse}
                  onClick={() => {
                    if (bucket === null) return;
                    browse(bucket);
                  }}
                >
                  <FolderOpenIcon />
                  {t('browse.picker.browse')}
                </Button>
                <Button
                  variant="outline"
                  disabled={!canBrowse}
                  onClick={() => {
                    if (bucket === null) return;
                    void navigate({
                      to: '/buckets/$bucketId/upload/$',
                      params: { bucketId: bucket, _splat: '' },
                    });
                  }}
                >
                  <UploadIcon />
                  {t('browse.toolbar.uploadFiles')}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('browse.picker.recent')}</CardTitle>
              <CardDescription>{t('browse.picker.recentHint')}</CardDescription>
            </CardHeader>
            <CardContent>
              {recent.length === 0 ? (
                <EmptyState
                  icon={ClockIcon}
                  title={t('browse.picker.noRecent')}
                  description={t('browse.picker.noRecentHint')}
                  className="py-6"
                />
              ) : (
                <ul className="flex flex-col gap-1">
                  {recent.map((item) => {
                    const known = bucketItems.find(
                      (candidate) =>
                        candidate.serverId === item.serverId && candidate.name === item.bucket,
                    );
                    return (
                      <li key={`${item.serverId}/${item.bucket}`}>
                        <div className="flex items-center gap-2 rounded-md p-1.5 hover:bg-accent">
                          <Button
                            variant="ghost"
                            className="h-auto min-w-0 grow justify-start gap-2 px-1.5 py-1 text-start"
                            onClick={() => browse(item.bucketId)}
                          >
                            {known === undefined ? (
                              <DatabaseIcon className="shrink-0 text-muted-foreground" />
                            ) : (
                              <ProviderMark provider={known.provider} size="sm" />
                            )}
                            <span className="ltr-isolate min-w-0 truncate font-mono">
                              {item.bucket}
                            </span>
                            <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">
                              {item.serverName}
                            </span>
                          </Button>
                          {known?.sizeBytes == null ? null : (
                            // The size is context, not the point: on a phone the
                            // bucket name and the remove button get the width.
                            <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
                              <Bytes value={known.sizeBytes} />
                            </Badge>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0"
                            aria-label={t('browse.picker.forget', { bucket: item.bucket })}
                            onClick={() => forget(item.serverId, item.bucket)}
                          >
                            <XIcon />
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
