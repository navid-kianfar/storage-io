import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ArchiveIcon,
  ChevronDownIcon,
  CopyPlusIcon,
  DownloadIcon,
  EllipsisIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderInputIcon,
  FolderPlusIcon,
  FolderUpIcon,
  GaugeIcon,
  GitBranchIcon,
  GlobeIcon,
  InfoIcon,
  LayersIcon,
  LayoutGridIcon,
  LinkIcon,
  ListFilterIcon,
  ListIcon,
  LockIcon,
  PanelRightOpenIcon,
  RefreshCwIcon,
  RepeatIcon,
  SearchIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SquarePenIcon,
  TagsIcon,
  TextCursorInputIcon,
  TimerIcon,
  Trash2Icon,
  UploadIcon,
  WebhookIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button, ButtonGroup } from '@/components/app/Button';
import { Card } from '@/components/app/Card';
import { Checkbox } from '@/components/app/Checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/app/DropdownMenu';
import { EmptyState } from '@/components/app/EmptyState';
import { Bytes, Num } from '@/components/app/Format';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/app/InputGroup';
import { Kbd } from '@/components/app/Kbd';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Sheet, SheetContent, SheetTitle } from '@/components/app/Sheet';
import { Spinner } from '@/components/app/Spinner';
import { filesFromDataTransfer } from '@/components/app/FileDropzone';
import { BucketHeader } from '@/features/buckets/components/BucketHeader';
import { useBucketDetail } from '@/features/buckets/api';
import { useServerList } from '@/features/shell/api';
import { enqueueDownload, enqueueUploads, recordCompletedDownload } from '@/features/transfers/engine';
import { toastProblem } from '@/lib/api/problems';
import { downloadBlob } from '@/lib/csv';
import { useDialogs } from '@/lib/dialogs/useDialogs';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { objectContentUrl, useDownloadZip, useObjectListing, useObjectMeta } from './api';
import { filterEntries, flattenPages, listingTotals, type Entry } from './entries';
import { FILE_KINDS, guessContentType, type FileKind } from './fileKind';
import { keysToGlob } from './keysToGlob';
import { ObjectInspector } from './components/ObjectInspector';
import { ObjectListing, type ListingView } from './components/ObjectListing';
import { PathBar } from './components/PathBar';
import { UploadPanel } from './components/UploadPanel';
import { CopyMoveDialog } from './dialogs/CopyMoveDialog';
import { DeleteObjectsDialog } from './dialogs/DeleteObjectsDialog';
import { EditContentsSheet } from './dialogs/EditContentsSheet';
import { ObjectMetadataDialog } from './dialogs/ObjectMetadataDialog';
import { RenameObjectDialog } from './dialogs/RenameObjectDialog';
import './dialogs/UploadDialog';
import './dialogs/ImportUrlDialog';
import './dialogs/NewFolderDialog';
import './dialogs/ShareLinkDialog';

/**
 * `/browse/$server/$bucket/$` — the object browser.
 *
 * The prefix is the route's splat, so a folder is a real address: back, forward,
 * bookmark and "send me the link" all work, and so does opening a deep prefix
 * directly. The filter, the view and the version toggle live in the search params
 * for the same reason; the selection deliberately does not, because a reload
 * restoring a selection the operator has forgotten about is how the wrong thing
 * gets deleted.
 *
 * Everything that changes objects is a single request per action — copy, move,
 * delete and the ZIP download each take the whole selection — and the three
 * per-object attribute changes (tags, storage class, retention) hand a selection to
 * the job engine rather than looping: the contract has no bulk endpoint for an
 * arbitrary key list, and a loop of 400 requests is not a bulk action.
 */

const SEARCH_DEBOUNCE_MS = 250;
const ZIP_FILENAME = 'objects.zip';
/** One shared empty set, so "nothing selected" is a stable reference. */
const EMPTY_SELECTION: ReadonlySet<string> = new Set();

interface BrowseSearch {
  readonly q?: string;
  readonly view?: string;
  readonly versions?: string | boolean;
  readonly types?: string;
  readonly obj?: string;
}

type MenuTarget = { readonly entry: Entry; readonly x: number; readonly y: number };

export function ObjectBrowserPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const dialogs = useDialogs();
  const isMobile = useIsMobile();
  const params = useParams({ from: '/protected/browse/$server/$bucket/$' });
  const search: BrowseSearch = useSearch({ strict: false });

  const prefix = normalizePrefix(params._splat ?? '');
  const scope = useMemo(
    () => ({ serverId: params.server, bucket: params.bucket }),
    [params.server, params.bucket],
  );

  const view: ListingView = search.view === 'grid' ? 'grid' : 'list';
  const showVersions = search.versions === 'true' || search.versions === true;
  const filterText = typeof search.q === 'string' ? search.q : '';
  const typeFilter = useMemo(() => parseTypes(search.types), [search.types]);
  const activeKey = typeof search.obj === 'string' ? search.obj : null;

  const setSearch = useCallback(
    (patch: Readonly<Record<string, string | undefined>>) => {
      void navigate({
        to: '/browse/$server/$bucket/$',
        params: { server: params.server, bucket: params.bucket, _splat: params._splat ?? '' },
        search: (previous: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...previous, ...patch };
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === '') delete next[key];
          }
          return next;
        },
        replace: true,
      });
    },
    [navigate, params._splat, params.bucket, params.server],
  );

  const goToPrefix = useCallback(
    (nextPrefix: string) => {
      void navigate({
        to: '/browse/$server/$bucket/$',
        params: { server: params.server, bucket: params.bucket, _splat: nextPrefix },
        search: (previous: Record<string, unknown>) => {
          const next = { ...previous };
          // The inspected object belongs to the folder that was left behind.
          delete next.obj;
          return next;
        },
      });
    },
    [navigate, params.bucket, params.server],
  );

  /* ------------------------------ data ------------------------------ */

  const servers = useServerList();
  const server = useMemo(
    () => servers.data?.items.find((item) => item.id === params.server || item.name === params.server),
    [servers.data, params.server],
  );
  const bucket = useBucketDetail(scope);
  const versioned = bucket.data?.versioning === 'enabled';

  const [searchText, setSearchText] = useState(filterText);
  useEffect(() => {
    if (searchText === filterText) return;
    const timer = window.setTimeout(
      () => setSearch({ q: searchText === '' ? undefined : searchText }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [searchText, filterText, setSearch]);

  const listing = useObjectListing(scope, { prefix, showVersions });
  const allEntries = useMemo(
    () => flattenPages(listing.data?.pages ?? [], prefix),
    [listing.data, prefix],
  );
  const entries = useMemo(
    () => filterEntries(allEntries, typeFilter, filterText),
    [allEntries, typeFilter, filterText],
  );
  const totals = useMemo(() => listingTotals(entries), [entries]);

  /* ---------------------------- selection --------------------------- */

  /**
   * A selection belongs to the listing it was made against, so it carries that
   * listing's identity: moving to another folder or turning versions on makes it
   * stale, which is derived during render rather than cleared by an effect.
   */
  const listingKey = `${prefix}|${String(showVersions)}`;
  const [selection, setSelection] = useState<{
    readonly key: string;
    readonly ids: ReadonlySet<string>;
  }>({ key: listingKey, ids: EMPTY_SELECTION });
  const selected = selection.key === listingKey ? selection.ids : EMPTY_SELECTION;
  const lastClickedRef = useRef<string | null>(null);

  const setSelected = useCallback(
    (ids: ReadonlySet<string>) => setSelection({ key: listingKey, ids }),
    [listingKey],
  );

  const toggle = useCallback(
    (id: string, isSelected: boolean) => {
      lastClickedRef.current = id;
      setSelection((current) => {
        const base = current.key === listingKey ? current.ids : EMPTY_SELECTION;
        const next = new Set(base);
        if (isSelected) next.add(id);
        else next.delete(id);
        return { key: listingKey, ids: next };
      });
    },
    [listingKey],
  );

  const selectRangeTo = useCallback(
    (id: string) => {
      const anchor = lastClickedRef.current;
      if (anchor === null) return;
      const from = entries.findIndex((entry) => entry.id === anchor);
      const to = entries.findIndex((entry) => entry.id === id);
      if (from === -1 || to === -1) return;
      const [start, end] = from <= to ? [from, to] : [to, from];
      const next = new Set(selected);
      for (const entry of entries.slice(start, end + 1)) next.add(entry.id);
      setSelected(next);
    },
    [entries, selected, setSelected],
  );

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.has(entry.id)),
    [entries, selected],
  );

  const allSelected = entries.length > 0 && selected.size === entries.length;

  /* ------------------------- the active object ---------------------- */

  const activeEntry = useMemo(
    () =>
      entries.find((entry) =>
        entry.kind === 'object' ? entry.object.key === activeKey : entry.prefix === activeKey,
      ) ?? null,
    [entries, activeKey],
  );
  const activeIsFolder = activeEntry?.kind === 'prefix';
  const meta = useObjectMeta(scope, activeIsFolder ? null : activeKey);

  /* ------------------------------ dialogs --------------------------- */

  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [copyMode, setCopyMode] = useState<'copy' | 'move' | null>(null);
  const [copyTargets, setCopyTargets] = useState<readonly Entry[]>([]);
  const [deleteTargets, setDeleteTargets] = useState<readonly Entry[]>([]);
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const zip = useDownloadZip(scope);

  /* ------------------------------ actions --------------------------- */

  const downloadEntry = useCallback(
    (entry: Entry) => {
      if (entry.kind !== 'object') {
        // A folder is a ZIP of everything under it — one request, not a walk.
        zip.mutate(
          { keys: [], prefixes: [entry.prefix] },
          {
            onSuccess: (blob) => {
              downloadBlob(`${entry.name}.zip`, blob);
              recordCompletedDownload(
                { ...scope, serverName: server?.name ?? scope.serverId },
                entry.prefix,
                blob.size,
              );
            },
            onError: (error) => toastProblem(error, tCommon),
          },
        );
        return;
      }
      enqueueDownload({
        scope: { ...scope, serverName: server?.name ?? scope.serverId },
        key: entry.object.key,
        sizeBytes: entry.object.size,
        versionId: entry.object.versionId ?? undefined,
      });
    },
    [scope, server?.name, tCommon, zip],
  );

  const downloadSelection = useCallback(() => {
    if (selectedEntries.length === 0) return;
    if (selectedEntries.length === 1) {
      downloadEntry(selectedEntries[0]!);
      return;
    }
    toast.info(t('browse.bulk.downloadPreparing'));
    zip.mutate(
      {
        keys: selectedEntries
          .filter((entry) => entry.kind === 'object')
          .map((entry) => (entry.kind === 'object' ? entry.object.key : '')),
        prefixes: selectedEntries
          .filter((entry) => entry.kind === 'prefix')
          .map((entry) => (entry.kind === 'prefix' ? entry.prefix : '')),
      },
      {
        onSuccess: (blob) => {
          downloadBlob(ZIP_FILENAME, blob);
          recordCompletedDownload(
            { ...scope, serverName: server?.name ?? scope.serverId },
            ZIP_FILENAME,
            blob.size,
          );
        },
        onError: (error) => toastProblem(error, tCommon),
      },
    );
  }, [downloadEntry, scope, selectedEntries, server?.name, t, tCommon, zip]);

  /** Hands a selection to the job engine: one request describes the whole set. */
  const runAsJob = useCallback(
    (jobType?: 'tag' | 'storage-class' | 'retention') => {
      const keys = selectedEntries
        .filter((entry) => entry.kind === 'object')
        .map((entry) => (entry.kind === 'object' ? entry.object.key : ''));
      dialogs.open('new-job', {
        server: scope.serverId,
        bucket: scope.bucket,
        prefix,
        glob: keysToGlob(keys),
        ...(jobType === undefined ? {} : { type: jobType }),
      });
    },
    [dialogs, prefix, scope.bucket, scope.serverId, selectedEntries],
  );

  const copyShareLinks = useCallback(() => {
    const urls = selectedEntries
      .filter((entry) => entry.kind === 'object')
      .map((entry) =>
        entry.kind === 'object'
          ? new URL(
              objectContentUrl(scope, entry.object.key, { inline: false }),
              window.location.origin,
            ).toString()
          : '',
      );
    void navigator.clipboard.writeText(urls.join('\n')).then(
      () => toast.success(tCommon('action.copied'), { description: String(urls.length) }),
      () => toast.error(tCommon('action.copy')),
    );
  }, [scope, selectedEntries, tCommon]);

  const openEntry = useCallback(
    (entry: Entry) => {
      if (entry.kind === 'prefix') {
        goToPrefix(entry.prefix);
        return;
      }
      setSearch({ obj: entry.object.key });
      setInspectorOpen(true);
    },
    [goToPrefix, setSearch],
  );

  /**
   * A single click marks the row and shows it in the inspector. On a phone there
   * is no second click to fall back on, so one tap does what a double-click does
   * on a desktop: a folder opens, an object opens its sheet.
   */
  const activate = useCallback(
    (entry: Entry) => {
      if (isMobile) {
        openEntry(entry);
        return;
      }
      setSearch({ obj: entry.kind === 'object' ? entry.object.key : entry.prefix });
      setInspectorOpen(true);
    },
    [isMobile, openEntry, setSearch],
  );

  /* ------------------------- page-wide drag & drop ------------------- */

  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      dragDepth.current += 1;
      setDragging(true);
    };
    const onDragLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      // Without this the browser navigates to the dropped file instead.
      event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      dragDepth.current = 0;
      setDragging(false);
      if (event.dataTransfer === null || !hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      void filesFromDataTransfer(event.dataTransfer, { allowFolders: true }).then((dropped) => {
        if (dropped.length === 0) return;
        enqueueUploads({
          scope: { ...scope, serverName: server?.name ?? scope.serverId },
          items: dropped.map((entry) => ({ file: entry.file, relativePath: entry.relativePath })),
          destPrefix: prefix,
          overwrite: false,
          detectContentType: true,
          guessContentType,
        });
        toast.info(t('browse.upload.started'), { description: prefix });
      });
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [prefix, scope, server?.name, t]);

  /* ------------------------------ shortcuts ------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const inField =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.closest('[role="dialog"]') !== null);
      if (inField) return;

      if (event.key === 'F2' && activeEntry?.kind === 'object') {
        event.preventDefault();
        setRenameKey(activeEntry.object.key);
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && activeEntry !== null) {
        event.preventDefault();
        setDeleteTargets(selectedEntries.length > 0 ? selectedEntries : [activeEntry]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeEntry, selectedEntries]);

  /* -------------------------------- render -------------------------- */

  const uploadParams = { server: params.server, bucket: params.bucket, prefix };

  const inspector =
    activeEntry === null || activeKey === null ? null : (
      <ObjectInspector
        scope={scope}
        objectKey={activeKey}
        isFolder={activeIsFolder}
        meta={meta.data}
        metaLoading={meta.isLoading}
        versioned={versioned}
        onClose={() => {
          setInspectorOpen(false);
          setSearch({ obj: undefined });
        }}
        onDownload={() => downloadEntry(activeEntry)}
        onEditContents={() => setEditKey(activeKey)}
        onEditMetadata={() => setMetadataOpen(true)}
        onMenu={(at) => setMenu({ entry: activeEntry, ...at })}
      />
    );

  return (
    <>
      <BucketHeader
        bucket={bucket.data}
        loading={bucket.isLoading}
        actions={
          <>
            <BucketSettingsMenu server={params.server} bucket={params.bucket} />
            <ButtonGroup>
              <Button onClick={() => dialogs.openHere('upload', uploadParams)}>
                <UploadIcon />
                {tCommon('action.upload')}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" aria-label={t('browse.toolbar.uploadMore')}>
                    <ChevronDownIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => dialogs.openHere('upload', uploadParams)}>
                    <FilePlusIcon />
                    {t('browse.toolbar.uploadFiles')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => dialogs.openHere('upload', uploadParams)}>
                    <FolderUpIcon />
                    {t('browse.toolbar.uploadFolder')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => dialogs.openHere('import-url', uploadParams)}>
                    <GlobeIcon />
                    {t('browse.toolbar.importUrl')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ButtonGroup>
          </>
        }
      />

      <div
        className={cn(
          'grid gap-(--gap)',
          inspectorOpen && !isMobile ? 'xl:grid-cols-[minmax(0,1fr)_22rem]' : 'grid-cols-1',
        )}
      >
        <Card className="min-w-0 overflow-hidden p-0">
          {/* toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b p-3">
            <PathBar bucket={params.bucket} prefix={prefix} onNavigate={goToPrefix} />

            <div className="ms-auto flex flex-wrap items-center gap-2">
              <InputGroup className="w-full sm:w-56">
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder={t('browse.toolbar.filter')}
                  aria-label={t('browse.toolbar.filter')}
                />
              </InputGroup>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={t('browse.toolbar.filterMenu')}
                    data-active={typeFilter.size > 0 ? 'true' : undefined}
                    className="data-[active=true]:border-primary data-[active=true]:text-primary"
                  >
                    <ListFilterIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel>{t('browse.filter.types')}</DropdownMenuLabel>
                  {FILE_KINDS.filter((kind) => kind !== 'folder').map((kind) => (
                    <DropdownMenuCheckboxItem
                      key={kind}
                      checked={typeFilter.has(kind)}
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={(checked) => {
                        const next = new Set(typeFilter);
                        if (checked) next.add(kind);
                        else next.delete(kind);
                        setSearch({ types: next.size === 0 ? undefined : [...next].join(',') });
                      }}
                    >
                      {t(`browse.filter.${kind}`)}
                    </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={showVersions}
                    disabled={!versioned}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) =>
                      setSearch({ versions: checked ? 'true' : undefined })
                    }
                  >
                    {t('browse.filter.showVersions')}
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <SegmentedControl
                options={[
                  {
                    value: 'list',
                    label: <ListIcon />,
                    'aria-label': t('browse.toolbar.listView'),
                  },
                  {
                    value: 'grid',
                    label: <LayoutGridIcon />,
                    'aria-label': t('browse.toolbar.gridView'),
                  },
                ]}
                value={view}
                onValueChange={(next) => setSearch({ view: next === 'list' ? undefined : next })}
                aria-label={t('browse.toolbar.listView')}
              />

              <Button
                variant="ghost"
                size="icon"
                aria-label={tCommon('action.refresh')}
                disabled={listing.isFetching}
                onClick={() => void listing.refetch()}
              >
                {listing.isFetching ? <Spinner /> : <RefreshCwIcon />}
              </Button>

              <Button
                variant="outline"
                size="icon"
                aria-label={t('browse.toolbar.newFolder')}
                onClick={() => dialogs.openHere('new-folder', uploadParams)}
              >
                <FolderPlusIcon />
              </Button>

              {inspectorOpen || isMobile ? null : (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('browse.inspector.open')}
                  onClick={() => setInspectorOpen(true)}
                >
                  <PanelRightOpenIcon className="flip-rtl" />
                </Button>
              )}
            </div>
          </div>

          {/* bulk bar */}
          {selected.size > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 border-b bg-primary/7 px-2.5 py-2">
              <span className="num ps-1 pe-2 text-sm font-semibold">
                {tCommon('table.rowsSelected', { count: selected.size })}
              </span>
              <Button variant="outline" size="sm" onClick={downloadSelection} disabled={zip.isPending}>
                {zip.isPending ? <Spinner /> : <DownloadIcon />}
                {t('browse.bulk.download')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCopyTargets(selectedEntries);
                  setCopyMode('copy');
                }}
              >
                <CopyPlusIcon />
                {t('browse.bulk.copyTo')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCopyTargets(selectedEntries);
                  setCopyMode('move');
                }}
              >
                <FolderInputIcon />
                {t('browse.bulk.moveTo')}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon-sm" aria-label={t('browse.bulk.more')}>
                    <EllipsisIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem onSelect={() => runAsJob('tag')}>
                    <TagsIcon />
                    {t('browse.bulk.editTags')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => runAsJob('storage-class')}>
                    <ArchiveIcon />
                    {t('browse.bulk.storageClass')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => runAsJob('retention')}>
                    <LockIcon />
                    {t('browse.bulk.retention')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={copyShareLinks}>
                    <LinkIcon />
                    {t('browse.bulk.shareLinks')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => runAsJob()}>
                    <LayersIcon />
                    {t('browse.bulk.asJob')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setDeleteTargets(selectedEntries)}
              >
                <Trash2Icon />
                {t('browse.bulk.delete')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="ms-auto"
                onClick={() => setSelected(EMPTY_SELECTION)}
              >
                {tCommon('table.clearSelection')}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(checked) =>
                  setSelected(checked === true ? new Set(entries.map((entry) => entry.id)) : new Set())
                }
                aria-label={tCommon('table.selectAllRows')}
              />
              <span className="text-[0.8125rem] text-muted-foreground">
                {tCommon('table.selectAllRows')}
              </span>
            </div>
          )}

          <ObjectListing
            entries={entries}
            view={view}
            selected={selected}
            activeId={activeEntry?.id ?? null}
            loading={listing.isLoading}
            loadingMore={listing.isFetchingNextPage}
            hasMore={listing.hasNextPage}
            onLoadMore={() => void listing.fetchNextPage()}
            onToggle={toggle}
            onRangeTo={selectRangeTo}
            onActivate={activate}
            onOpen={openEntry}
            onMenu={(entry, at) => setMenu({ entry, ...at })}
            emptyState={
              <EmptyState
                icon={FolderPlusIcon}
                title={
                  filterText === '' && typeFilter.size === 0
                    ? t('browse.empty.title')
                    : t('browse.empty.filtered')
                }
                description={t('browse.empty.description')}
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() => dialogs.openHere('new-folder', uploadParams)}
                    >
                      <FolderPlusIcon />
                      {t('browse.toolbar.newFolder')}
                    </Button>
                    <Button onClick={() => dialogs.openHere('upload', uploadParams)}>
                      <UploadIcon />
                      {tCommon('action.upload')}
                    </Button>
                  </div>
                }
              />
            }
          />

          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 text-[0.8125rem] text-muted-foreground">
            <span>
              {t('browse.foot.items', { count: totals.count })} · <Bytes value={totals.sizeBytes} />
            </span>
            <span>
              {listing.hasNextPage ? (
                <Num value={entries.length} />
              ) : (
                t('browse.foot.allLoaded')
              )}
            </span>
          </div>
        </Card>

        {inspectorOpen && !isMobile && inspector !== null ? (
          <Card className="sticky top-20 max-h-[calc(100dvh-7rem)] min-w-0 overflow-hidden p-0">
            {inspector}
          </Card>
        ) : null}
      </div>

      {/* The inspector becomes a sheet on a phone: there is no room beside the list. */}
      <Sheet
        open={isMobile && inspectorOpen && inspector !== null}
        onOpenChange={(open) => {
          if (!open) setInspectorOpen(false);
        }}
      >
        <SheetContent side="right" className="w-full p-0 sm:max-w-md">
          <SheetTitle className="sr-only">{t('browse.inspector.label')}</SheetTitle>
          {inspector}
        </SheetContent>
      </Sheet>

      <UploadPanel />

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-primary/10 backdrop-blur-[1px]">
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-primary bg-card px-8 py-6 shadow-concept-lg">
            <UploadIcon className="size-6 text-primary" aria-hidden="true" />
            <span className="text-sm font-medium">{t('browse.dropActive')}</span>
            <span className="ltr-isolate font-mono text-xs text-muted-foreground">
              {params.bucket}/{prefix}
            </span>
          </div>
        </div>
      ) : null}

      {/* The row / context menu, positioned where it was opened. */}
      {menu === null ? null : (
        <RowMenu
          target={menu}
          onClose={() => setMenu(null)}
          onAction={(action) => {
            const entry = menu.entry;
            setMenu(null);
            switch (action) {
              case 'preview':
                activate(entry);
                setInspectorOpen(true);
                return;
              case 'download':
                downloadEntry(entry);
                return;
              case 'share':
                if (entry.kind !== 'object') return;
                dialogs.openHere('share-link', {
                  server: params.server,
                  bucket: params.bucket,
                  key: entry.object.key,
                });
                return;
              case 'edit':
                if (entry.kind !== 'object') return;
                setEditKey(entry.object.key);
                return;
              case 'rename':
                if (entry.kind !== 'object') return;
                setRenameKey(entry.object.key);
                return;
              case 'copy':
                setCopyTargets([entry]);
                setCopyMode('copy');
                return;
              case 'move':
                setCopyTargets([entry]);
                setCopyMode('move');
                return;
              case 'metadata':
                if (entry.kind !== 'object') return;
                setSearch({ obj: entry.object.key });
                setMetadataOpen(true);
                return;
              case 'delete':
                setDeleteTargets([entry]);
                return;
            }
          }}
        />
      )}

      <CopyMoveDialog
        open={copyMode !== null}
        onOpenChange={(open) => {
          if (!open) setCopyMode(null);
        }}
        mode={copyMode ?? 'copy'}
        scope={scope}
        entries={copyTargets}
        sourcePrefix={prefix}
        onDone={() => setSelected(EMPTY_SELECTION)}
      />

      <DeleteObjectsDialog
        open={deleteTargets.length > 0}
        onOpenChange={(open) => {
          if (!open) setDeleteTargets([]);
        }}
        scope={scope}
        entries={deleteTargets}
        versioned={versioned}
        onDeleted={() => {
          setSelected(EMPTY_SELECTION);
          setSearch({ obj: undefined });
        }}
      />

      {renameKey === null ? null : (
        <RenameObjectDialog
          open
          onOpenChange={(open) => {
            if (!open) setRenameKey(null);
          }}
          scope={scope}
          objectKey={renameKey}
          onRenamed={(newKey) => {
            setRenameKey(null);
            setSearch({ obj: newKey });
          }}
        />
      )}

      {editKey === null ? null : (
        <EditContentsSheet
          key={editKey}
          open
          onOpenChange={(open) => {
            if (!open) setEditKey(null);
          }}
          scope={scope}
          objectKey={editKey}
          sizeBytes={meta.data?.size ?? 0}
          versioned={versioned}
        />
      )}

      {activeKey === null || activeIsFolder ? null : (
        <ObjectMetadataDialog
          open={metadataOpen}
          onOpenChange={setMetadataOpen}
          scope={scope}
          objectKey={activeKey}
          meta={meta.data}
        />
      )}
    </>
  );
}

/* ------------------------------- helpers -------------------------------- */

function normalizePrefix(splat: string): string {
  if (splat === '') return '';
  return splat.endsWith('/') ? splat : `${splat}/`;
}

function parseTypes(value: string | undefined): ReadonlySet<FileKind> {
  if (value === undefined || value === '') return new Set();
  const known = new Set<FileKind>();
  for (const part of value.split(',')) {
    if ((FILE_KINDS as readonly string[]).includes(part)) known.add(part as FileKind);
  }
  return known;
}

function hasFiles(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null) return false;
  return Array.from(dataTransfer.types).includes('Files');
}

/** The bucket-settings menu from the concept: every section, as a deep link. */
function BucketSettingsMenu({
  server,
  bucket,
}: {
  readonly server: string;
  readonly bucket: string;
}) {
  const { t } = useTranslation('pages');
  const navigate = useNavigate();

  const sections = [
    { id: 'general', icon: InfoIcon, label: t('bucket.nav.general') },
    { id: 'access', icon: ShieldCheckIcon, label: t('bucket.nav.access') },
    { id: 'quota', icon: GaugeIcon, label: t('bucket.nav.quota') },
    { id: 'versioning', icon: GitBranchIcon, label: t('bucket.nav.versioning') },
    { id: 'lifecycle', icon: TimerIcon, label: t('bucket.nav.lifecycle') },
    { id: 'replication', icon: RepeatIcon, label: t('bucket.nav.replication') },
    { id: 'events', icon: WebhookIcon, label: t('bucket.nav.events') },
    { id: 'cors', icon: GlobeIcon, label: t('bucket.nav.cors') },
  ] as const;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <Settings2Icon />
          {t('browse.toolbar.bucketSettings')}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="ltr-isolate font-mono">{bucket}</DropdownMenuLabel>
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <DropdownMenuItem
              key={section.id}
              onSelect={() =>
                void navigate({
                  to: '/buckets/$server/$bucket',
                  params: { server, bucket },
                  hash: section.id,
                })
              }
            >
              <Icon />
              {section.label}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() =>
            void navigate({
              to: '/buckets/$server/$bucket',
              params: { server, bucket },
              hash: 'danger',
            })
          }
        >
          <Trash2Icon />
          {t('bucket.danger.deleteTitle')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* --------------------------- the row / context menu ---------------------- */

type RowAction =
  | 'preview'
  | 'download'
  | 'share'
  | 'edit'
  | 'rename'
  | 'copy'
  | 'move'
  | 'metadata'
  | 'delete';

/**
 * One menu serves the "…" button and the right-click, so both offer exactly the
 * same actions. It is anchored to the pointer with a zero-size virtual trigger,
 * which is how Radix positions a context menu without a real element under it.
 */
function RowMenu({
  target,
  onClose,
  onAction,
}: {
  readonly target: MenuTarget;
  readonly onClose: () => void;
  readonly onAction: (action: RowAction) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const isObject = target.entry.kind === 'object';
  const isText = target.entry.kind === 'object' && target.entry.fileKind === 'text';

  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden="true"
          style={{ position: 'fixed', left: target.x, top: target.y, width: 0, height: 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => onAction('preview')}>
          {t('browse.row.preview')}
          <Kbd className="ms-auto">Space</Kbd>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction('download')}>
          <DownloadIcon />
          {t('browse.row.download')}
        </DropdownMenuItem>
        {isObject ? (
          <DropdownMenuItem onSelect={() => onAction('share')}>
            <LinkIcon />
            {t('browse.row.shareLink')}
          </DropdownMenuItem>
        ) : null}
        {isText ? (
          <DropdownMenuItem onSelect={() => onAction('edit')}>
            <SquarePenIcon />
            {t('browse.row.editContents')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {isObject ? (
          <DropdownMenuItem onSelect={() => onAction('rename')}>
            <TextCursorInputIcon />
            {t('browse.row.rename')}
            <Kbd className="ms-auto">F2</Kbd>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => onAction('copy')}>
          <CopyPlusIcon />
          {t('browse.row.copyTo')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction('move')}>
          <FolderInputIcon />
          {t('browse.row.moveTo')}
        </DropdownMenuItem>
        {isObject ? (
          <DropdownMenuItem onSelect={() => onAction('metadata')}>
            <FileTextIcon />
            {t('browse.row.editMetadata')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onAction('delete')}>
          <Trash2Icon />
          {t('browse.row.delete')}
          <Kbd className="ms-auto">⌫</Kbd>
        </DropdownMenuItem>
        <span className="sr-only">{tCommon('table.rowActions')}</span>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
