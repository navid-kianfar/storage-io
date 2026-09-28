import {
  PRESIGN_MAX_SECONDS,
  type ObjectMeta,
  type ObjectVersion,
} from '@storage-io/contracts';
import {
  DownloadIcon,
  EllipsisIcon,
  LinkIcon,
  PencilIcon,
  RotateCcwIcon,
  SquarePenIcon,
  XIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/app/Badge';
import { Button } from '@/components/app/Button';
import { CopyField } from '@/components/app/CopyField';
import { Bytes, DateTime, Num } from '@/components/app/Format';
import { Label } from '@/components/app/Label';
import { OptionRow } from '@/components/app/FormRow';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Skeleton } from '@/components/app/Skeleton';
import { Spinner } from '@/components/app/Spinner';
import { StatusDot } from '@/components/app/StatusBadge';
import { Switch } from '@/components/app/Switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/app/Tabs';
import { TagEditor } from '@/components/app/TagEditor';
import { toastProblem } from '@/lib/api/problems';
import { DefinitionList } from '@/features/buckets/sections/DefinitionList';
import {
  objectContentUrl,
  useObjectVersions,
  usePresignObject,
  useRestoreVersion,
  useSaveObjectTags,
  type ObjectScope,
} from '../api';
import { KIND_ICONS, KIND_TINTS, fileKind } from '../fileKind';
import { ObjectPreview } from './ObjectPreview';
import { cn } from '@/lib/utils';

/**
 * The inspector: what one object is, what versions it has, its tags, and a share
 * link. Rendered as a side panel on a wide screen and inside a Sheet on a phone —
 * the same component either way, which is why it takes no layout decisions of its
 * own beyond filling its container.
 *
 * Versions are only fetched when the bucket is versioned: on an unversioned bucket
 * the endpoint answers with one entry that says nothing, and the tab says so
 * instead.
 */

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const WEEK_SECONDS = 7 * DAY_SECONDS;
type Expiry = 'hour' | 'day' | 'week';
interface SignedLink {
  readonly url: string;
  readonly expiresAt: string;
  /** The object, expiry and disposition this signature was made for. */
  readonly signature: string;
}

const TAG_LIMIT = 10;

const EXPIRY_SECONDS: Readonly<Record<Expiry, number>> = {
  hour: HOUR_SECONDS,
  day: DAY_SECONDS,
  week: Math.min(WEEK_SECONDS, PRESIGN_MAX_SECONDS),
};

export interface ObjectInspectorProps {
  readonly scope: ObjectScope;
  readonly objectKey: string;
  readonly isFolder: boolean;
  readonly meta: ObjectMeta | undefined;
  readonly metaLoading: boolean;
  readonly versioned: boolean;
  readonly onClose: () => void;
  readonly onDownload: () => void;
  readonly onEditContents: () => void;
  readonly onEditMetadata: () => void;
  readonly onMenu: (at: { readonly x: number; readonly y: number }) => void;
}

export function ObjectInspector({
  scope,
  objectKey,
  isFolder,
  meta,
  metaLoading,
  versioned,
  onClose,
  onDownload,
  onEditContents,
  onEditMetadata,
  onMenu,
}: ObjectInspectorProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  // The open tab belongs to the object it was opened on: a different object starts
  // at Details again, derived during render rather than reset by an effect.
  const [tabState, setTabState] = useState({ key: objectKey, tab: 'details' });
  const tab = tabState.key === objectKey ? tabState.tab : 'details';
  const setTab = (next: string) => setTabState({ key: objectKey, tab: next });

  const kind = isFolder ? 'folder' : fileKind(objectKey, meta?.contentType ?? null);
  const Icon = KIND_ICONS[kind];
  const name = objectKey.replace(/\/$/, '').split('/').pop() ?? objectKey;
  const versions = useObjectVersions(scope, objectKey, versioned && !isFolder);
  const versionCount = versions.data?.items.length ?? meta?.versionCount ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 border-b p-4">
        <span className={cn('grid size-8 shrink-0 place-items-center rounded-md', KIND_TINTS[kind])}>
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 grow flex-col">
          <span className="ltr-isolate truncate text-sm font-medium">{name}</span>
          <span className="text-xs text-muted-foreground">
            {isFolder ? (
              t('browse.folder')
            ) : (
              <>
                <Bytes value={meta?.size ?? null} />
                {meta?.contentType == null ? null : (
                  <>
                    {' · '}
                    <span className="font-mono">{meta.contentType}</span>
                  </>
                )}
              </>
            )}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('browse.inspector.close')}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>

      <div className="py-4">
        <ObjectPreview
          scope={scope}
          meta={meta}
          loading={metaLoading}
          isFolder={isFolder}
          objectKey={objectKey}
        />
      </div>

      {isFolder ? null : (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          <Button variant="outline" size="sm" onClick={onDownload}>
            <DownloadIcon />
            {tCommon('action.download')}
          </Button>
          {kind === 'text' ? (
            <Button variant="outline" size="sm" onClick={onEditContents}>
              <SquarePenIcon />
              {tCommon('action.edit')}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setTab('share')}>
            <LinkIcon />
            {t('browse.inspector.tabs.share')}
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('browse.row.actions')}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onMenu({ x: rect.right, y: rect.bottom });
            }}
          >
            <EllipsisIcon />
          </Button>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 grow flex-col">
        <TabsList className="mx-4 grid grid-cols-4">
          <TabsTrigger value="details">{t('browse.inspector.tabs.details')}</TabsTrigger>
          <TabsTrigger value="versions" disabled={isFolder}>
            {t('browse.inspector.tabs.versions')}
            {versionCount === null ? null : (
              <Badge variant="secondary" className="ms-1">
                <Num value={versionCount} />
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="tags" disabled={isFolder}>
            {t('browse.inspector.tabs.tags')}
          </TabsTrigger>
          <TabsTrigger value="share" disabled={isFolder}>
            {t('browse.inspector.tabs.share')}
          </TabsTrigger>
        </TabsList>

        <div className="min-h-0 grow overflow-auto p-4">
          <TabsContent value="details" className="mt-0">
            <DetailsTab
              scope={scope}
              objectKey={objectKey}
              meta={meta}
              loading={metaLoading}
              isFolder={isFolder}
              onEditMetadata={onEditMetadata}
            />
          </TabsContent>

          <TabsContent value="versions" className="mt-0">
            <VersionsTab
              scope={scope}
              objectKey={objectKey}
              versioned={versioned}
              versions={versions.data?.items ?? []}
              loading={versions.isLoading}
            />
          </TabsContent>

          <TabsContent value="tags" className="mt-0">
            <TagsTab scope={scope} objectKey={objectKey} meta={meta} />
          </TabsContent>

          <TabsContent value="share" className="mt-0">
            <ShareTab scope={scope} objectKey={objectKey} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

/* --------------------------------- details ------------------------------- */

function DetailsTab({
  scope,
  objectKey,
  meta,
  loading,
  isFolder,
  onEditMetadata,
}: {
  readonly scope: ObjectScope;
  readonly objectKey: string;
  readonly meta: ObjectMeta | undefined;
  readonly loading: boolean;
  readonly isFolder: boolean;
  readonly onEditMetadata: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const fullKey = `${scope.bucket}/${objectKey}`;

  if (isFolder) {
    return (
      <div className="flex flex-col gap-4">
        <CopyField value={fullKey} label={t('browse.inspector.key')} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  const metadataEntries = Object.entries(meta?.metadata ?? {});

  return (
    <div className="flex flex-col gap-4">
      <CopyField value={fullKey} label={t('browse.inspector.key')} />

      <DefinitionList
        className="sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]"
        rows={[
          { label: t('browse.inspector.size'), value: <Bytes value={meta?.size ?? null} /> },
          {
            label: t('browse.inspector.contentType'),
            value: meta?.contentType ?? '—',
            mono: true,
          },
          {
            label: t('browse.inspector.modified'),
            value: <DateTime value={meta?.lastModified ?? null} style="datetime" />,
          },
          {
            label: t('browse.inspector.storageClass'),
            value: meta?.storageClass ?? 'STANDARD',
            mono: true,
          },
          { label: t('browse.inspector.etag'), value: meta?.etag ?? '—', mono: true },
          { label: t('browse.inspector.versionId'), value: meta?.versionId ?? '—', mono: true },
          {
            label: t('browse.inspector.retention'),
            value:
              meta?.retention == null ? (
                tCommon('state.none')
              ) : (
                <Badge variant="info">
                  {meta.retention.mode} · <DateTime value={meta.retention.until} style="date" />
                </Badge>
              ),
          },
          {
            label: t('browse.inspector.legalHold'),
            value:
              meta?.legalHold === true ? (
                <Badge variant="warning">{t('browse.inspector.legalHold')}</Badge>
              ) : (
                tCommon('state.none')
              ),
          },
        ]}
      />

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t('browse.inspector.metadata')}</span>
        {metadataEntries.length === 0 ? (
          <p className="text-[0.8125rem] text-muted-foreground">
            {t('browse.inspector.noMetadata')}
          </p>
        ) : (
          <DefinitionList
            className="sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]"
            rows={metadataEntries.map(([key, value]) => ({
              label: <span className="font-mono text-xs">{key}</span>,
              value,
              mono: true,
            }))}
          />
        )}
        <Button variant="ghost" size="sm" className="self-start" onClick={onEditMetadata}>
          <PencilIcon />
          {t('browse.inspector.editMetadata')}
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------- versions ------------------------------- */

function VersionsTab({
  scope,
  objectKey,
  versioned,
  versions,
  loading,
}: {
  readonly scope: ObjectScope;
  readonly objectKey: string;
  readonly versioned: boolean;
  readonly versions: readonly ObjectVersion[];
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const restore = useRestoreVersion(scope);

  if (!versioned) {
    return (
      <p className="text-[0.8125rem] text-muted-foreground">
        {t('browse.inspector.versioningOff')}
      </p>
    );
  }

  if (loading) return <Skeleton className="h-24 w-full" />;

  if (versions.length <= 1) {
    return (
      <p className="text-[0.8125rem] text-muted-foreground">{t('browse.inspector.noVersions')}</p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {versions.map((version) => (
        <li key={version.versionId} className="flex gap-3">
          <span className="pt-1.5">
            <StatusDot
              tone={version.deleteMarker ? 'err' : version.isLatest ? 'ok' : 'muted'}
            />
          </span>
          <div className="flex min-w-0 grow flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2">
              <span className="ltr-isolate truncate font-mono text-xs">{version.versionId}</span>
              {version.isLatest ? (
                <Badge variant="success">{t('browse.inspector.current')}</Badge>
              ) : version.deleteMarker ? (
                <Badge variant="danger">{t('browse.inspector.deleteMarker')}</Badge>
              ) : (
                <span className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={restore.isPending}
                    onClick={() =>
                      restore.mutate(
                        { key: objectKey, versionId: version.versionId },
                        {
                          onSuccess: () => toast.success(t('browse.inspector.restored')),
                          onError: (error) => toastProblem(error, tCommon),
                        },
                      )
                    }
                  >
                    {restore.isPending ? <Spinner /> : <RotateCcwIcon />}
                    {t('browse.inspector.restore')}
                  </Button>
                  <Button variant="ghost" size="icon-sm" asChild>
                    <a
                      href={objectContentUrl(scope, objectKey, {
                        inline: false,
                        versionId: version.versionId,
                      })}
                      aria-label={t('browse.inspector.downloadVersion')}
                    >
                      <DownloadIcon />
                    </a>
                  </Button>
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              <DateTime value={version.lastModified} style="datetime" />
              {version.deleteMarker ? null : (
                <>
                  {' · '}
                  <Bytes value={version.size} />
                </>
              )}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------- tags --------------------------------- */

function TagsTab({
  scope,
  objectKey,
  meta,
}: {
  readonly scope: ObjectScope;
  readonly objectKey: string;
  readonly meta: ObjectMeta | undefined;
}) {
  const savedTags = meta?.tags ?? {};
  // Keyed by the object and its saved tags, so the draft starts from the server's
  // answer without an effect copying it in.
  return (
    <TagsForm
      key={`${objectKey}:${JSON.stringify(savedTags)}`}
      scope={scope}
      objectKey={objectKey}
      savedTags={savedTags}
    />
  );
}

function TagsForm({
  scope,
  objectKey,
  savedTags,
}: {
  readonly scope: ObjectScope;
  readonly objectKey: string;
  readonly savedTags: Readonly<Record<string, string>>;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const save = useSaveObjectTags(scope);
  const [tags, setTags] = useState<Readonly<Record<string, string>>>(savedTags);
  const dirty = JSON.stringify(tags) !== JSON.stringify(savedTags);

  return (
    <div className="flex flex-col gap-3">
      <TagEditor
        tags={tags}
        onTagsChange={setTags}
        disabled={save.isPending}
        hint={t('browse.inspector.tagsLimit', { count: TAG_LIMIT })}
      />
      {dirty ? (
        <Button
          size="sm"
          className="self-start"
          disabled={save.isPending}
          onClick={() =>
            save.mutate(
              { key: objectKey, tags },
              {
                onSuccess: () => toast.success(t('browse.inspector.tagsSaved')),
                onError: (error) => toastProblem(error, tCommon),
              },
            )
          }
        >
          {save.isPending ? <Spinner /> : null}
          {tCommon('action.save')}
        </Button>
      ) : null}
    </div>
  );
}

/* ---------------------------------- share -------------------------------- */

function ShareTab({
  scope,
  objectKey,
}: {
  readonly scope: ObjectScope;
  readonly objectKey: string;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const forceId = useId();
  const [expiry, setExpiry] = useState<Expiry>('day');
  const [forceDownload, setForceDownload] = useState(true);
  const [signed, setSigned] = useState<SignedLink | null>(null);
  const presign = usePresignObject(scope);

  // A signature belongs to the exact parameters it was made with: changing the
  // object, the expiry or the disposition makes the held link stale, which is
  // derived here rather than cleared by an effect.
  const signature = `${objectKey}:${expiry}:${String(forceDownload)}`;
  const link = signed?.signature === signature ? signed : null;

  return (
    <div className="flex flex-col gap-4">
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

      <div className="rounded-lg border px-3">
        <OptionRow
          label={<Label htmlFor={forceId}>{t('browse.inspector.forceDownload')}</Label>}
          hint={t('browse.inspector.forceDownloadHint')}
        >
          <Switch id={forceId} checked={forceDownload} onCheckedChange={setForceDownload} />
        </OptionRow>
      </div>

      {link === null ? (
        <Button
          className="self-start"
          disabled={presign.isPending}
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
      ) : (
        <div className="flex flex-col gap-2">
          <CopyField value={link.url} multiline label={t('browse.inspector.tabs.share')} />
          <p className="text-[0.8125rem] text-muted-foreground">
            {t('browse.inspector.linkExpires')} <DateTime value={link.expiresAt} style="datetime" />
          </p>
        </div>
      )}

      <p className="text-[0.8125rem] text-muted-foreground">{t('browse.inspector.linkHint')}</p>
    </div>
  );
}
