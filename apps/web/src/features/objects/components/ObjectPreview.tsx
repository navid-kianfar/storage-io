import type { ObjectMeta } from '@storage-io/contracts';
import { ExternalLinkIcon, FileArchiveIcon, FileIcon, FolderIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/app/Button';
import { CodeEditor } from '@/components/app/CodeEditor';
import { Skeleton } from '@/components/app/Skeleton';
import { useFormat } from '@/lib/format/FormatProvider';
import {
  fetchObjectText,
  objectContentUrl,
  useArchiveEntries,
  type ObjectScope,
} from '../api';
import {
  KIND_ICONS,
  MEDIA_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  editorLanguage,
  fileKind,
  type FileKind,
} from '../fileKind';

/**
 * The inspector's preview.
 *
 * Every preview is capped: an image or a video is fetched in full by the browser
 * and a text preview is loaded into CodeMirror, so a 4 GB object gets a size notice
 * and a link rather than a hung tab. That is the difference between a preview that
 * works on real data and one that works on the demo file.
 *
 * An archive is listed by the API through `GET …/objects/archive-entries`, which
 * never downloads the object: a ZIP costs two or three ranged reads whatever its
 * size. The browser could not do that without pulling the whole file down.
 */

const PREVIEW_HEIGHT = '12rem';

export function ObjectPreview({
  scope,
  meta,
  loading,
  isFolder,
  objectKey,
  folderCount,
}: {
  readonly scope: ObjectScope;
  readonly meta: ObjectMeta | undefined;
  readonly loading: boolean;
  readonly isFolder: boolean;
  readonly objectKey: string;
  readonly folderCount?: number;
}) {
  const { t } = useTranslation('pages');
  const format = useFormat();

  if (isFolder) {
    return (
      <PreviewFrame>
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <FolderIcon className="size-8" aria-hidden="true" />
          {folderCount === undefined ? null : (
            <span className="text-sm">
              {t('browse.inspector.objectsInFolder', { count: folderCount })}
            </span>
          )}
        </div>
      </PreviewFrame>
    );
  }

  if (loading) return <Skeleton className="mx-4 h-48 rounded-lg" />;

  const kind: FileKind = fileKind(objectKey, meta?.contentType ?? null);
  const size = meta?.size ?? 0;
  const url = objectContentUrl(scope, objectKey, { inline: true, versionId: meta?.versionId ?? undefined });

  if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf') {
    if (size > MEDIA_PREVIEW_MAX_BYTES) {
      return <TooLarge size={size} url={url} sizeText={format.bytes(size)} />;
    }
    return (
      <PreviewFrame>
        {kind === 'image' ? (
          <img src={url} alt={objectKey} className="max-h-48 max-w-full object-contain" />
        ) : kind === 'video' ? (
          <video src={url} controls className="max-h-48 w-full" />
        ) : kind === 'audio' ? (
          <audio src={url} controls className="w-full" />
        ) : (
          <iframe src={url} title={objectKey} className="h-48 w-full rounded-md border-0" />
        )}
      </PreviewFrame>
    );
  }

  if (kind === 'archive') {
    return (
      <ArchivePreview
        key={objectKey}
        scope={scope}
        objectKey={objectKey}
        versionId={meta?.versionId ?? undefined}
      />
    );
  }

  if (kind === 'text') {
    if (size > TEXT_PREVIEW_MAX_BYTES) {
      return <TooLarge size={size} url={url} sizeText={format.bytes(size)} />;
    }
    return <TextPreview key={objectKey} scope={scope} objectKey={objectKey} />;
  }

  const Icon = KIND_ICONS[kind];
  return (
    <PreviewFrame>
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <Icon className="size-8" aria-hidden="true" />
        <span className="text-sm">{t('browse.inspector.noPreview')}</span>
        <Button variant="outline" size="sm" asChild>
          <a href={url} target="_blank" rel="noreferrer">
            <ExternalLinkIcon />
            {t('browse.inspector.openInTab')}
          </a>
        </Button>
      </div>
    </PreviewFrame>
  );
}

function PreviewFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mx-4 grid min-h-32 place-items-center overflow-hidden rounded-lg border bg-muted/40 p-3">
      {children}
    </div>
  );
}

function TooLarge({
  url,
  sizeText,
}: {
  readonly size: number;
  readonly url: string;
  readonly sizeText: string;
}) {
  const { t } = useTranslation('pages');
  return (
    <PreviewFrame>
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <span className="text-sm">{t('browse.inspector.previewTooLarge', { size: sizeText })}</span>
        <Button variant="outline" size="sm" asChild>
          <a href={url} target="_blank" rel="noreferrer">
            <ExternalLinkIcon />
            {t('browse.inspector.openInTab')}
          </a>
        </Button>
      </div>
    </PreviewFrame>
  );
}

/**
 * Text, JSON and Markdown go through the same read-only CodeEditor the editing
 * sheet uses, so the two views of one file look the same.
 */
function TextPreview({
  scope,
  objectKey,
}: {
  readonly scope: ObjectScope;
  readonly objectKey: string;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // No reset here: the parent keys this component by the object, so a different
  // object mounts a fresh one and the only setState calls are the fetch's own.
  useEffect(() => {
    let cancelled = false;
    fetchObjectText(scope, objectKey).then(
      (content) => {
        if (!cancelled) setText(content);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scope, objectKey]);

  if (failed) {
    return (
      <PreviewFrame>
        <span className="text-sm text-muted-foreground">{tCommon('state.error')}</span>
      </PreviewFrame>
    );
  }

  if (text === null) return <Skeleton className="mx-4 h-48 rounded-lg" />;

  return (
    <div className="px-4">
      <CodeEditor
        value={text}
        readOnly
        showLineNumbers={false}
        language={editorLanguage(objectKey)}
        height={PREVIEW_HEIGHT}
        ariaLabel={t('browse.inspector.noPreview')}
      />
    </div>
  );
}

/**
 * What is inside a ZIP or a tar.
 *
 * `format: 'unsupported'` is a normal answer — the pane asks about anything that
 * looks like an archive, and a `.gz` that is not a tarball is not an error. A tar
 * has no index, so the API reads it from the start and says when its budget ran
 * out; `truncated` is shown rather than hidden, because a partial list that looks
 * complete is worse than no list.
 */
function ArchivePreview({
  scope,
  objectKey,
  versionId,
}: {
  readonly scope: ObjectScope;
  readonly objectKey: string;
  readonly versionId?: string;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const format = useFormat();
  const entries = useArchiveEntries(scope, objectKey, versionId);

  if (entries.isPending) return <Skeleton className="mx-4 h-48 rounded-lg" />;

  if (entries.isError) {
    return (
      <PreviewFrame>
        <span className="text-sm text-muted-foreground">{tCommon('state.error')}</span>
      </PreviewFrame>
    );
  }

  const { format: archiveFormat, entries: items, truncated } = entries.data;

  if (archiveFormat === 'unsupported' || items.length === 0) {
    return (
      <PreviewFrame>
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <FileArchiveIcon className="size-8" aria-hidden="true" />
          <span className="max-w-64 text-center text-sm">
            {archiveFormat === 'unsupported'
              ? t('browse.inspector.archiveUnsupported')
              : t('browse.inspector.archiveEmpty')}
          </span>
        </div>
      </PreviewFrame>
    );
  }

  return (
    <div className="mx-4 flex flex-col gap-1.5 overflow-hidden rounded-lg border bg-muted/40 p-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-xs font-medium text-muted-foreground uppercase">
          {archiveFormat}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('browse.inspector.archiveCount', { count: items.length })}
        </span>
      </div>
      <ul className="max-h-44 overflow-auto">
        {items.map((entry) => (
          <li
            key={entry.path}
            className="flex items-center gap-2 rounded-sm px-1 py-0.5 text-xs hover:bg-accent"
          >
            {entry.dir ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="ltr-isolate min-w-0 truncate font-mono">{entry.path}</span>
            {entry.dir ? null : (
              <span className="num ms-auto shrink-0 text-muted-foreground">
                {format.bytes(entry.size)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {truncated ? (
        <p className="px-1 text-xs text-warning-foreground">
          {t('browse.inspector.archiveTruncated')}
        </p>
      ) : null}
    </div>
  );
}
