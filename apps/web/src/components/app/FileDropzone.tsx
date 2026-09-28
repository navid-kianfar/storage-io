import { FileIcon, FolderUpIcon, UploadCloudIcon, XIcon } from 'lucide-react';
import { useCallback, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Bytes } from '@/components/app/Format';
import { useFormat } from '@/lib/format/FormatProvider';
import { cn } from '@/lib/utils';

/**
 * The file picker. A native `<input type="file">` exists exactly once in the app —
 * here, hidden inside this component — and nothing else in the codebase may use
 * one (the ESLint rule enforces it).
 *
 * Supports drag-and-drop, click-to-browse, folder upload with the relative path
 * preserved, per-file removal, and accept/size/count rejection with a reason the
 * user can read.
 *
 * Folders, in two places and two ways, because the browser offers two:
 *
 * - *picking* a folder needs a second input carrying `webkitdirectory`, since that
 *   attribute turns an input into a folder-only picker — one input cannot offer
 *   both. With `allowFolders` there are therefore two triggers.
 * - *dropping* a folder does not put its contents in `dataTransfer.files` at all;
 *   only `DataTransferItem.webkitGetAsEntry()` reaches them, recursively. That walk
 *   is {@link filesFromDataTransfer}, exported so a page that accepts a drop
 *   anywhere (the object browser) gets the same paths as the dialog.
 */

export interface DroppedFile {
  readonly file: File;
  /** The path inside the dropped folder, or just the name for a plain file. */
  readonly relativePath: string;
}

export interface FileRejection {
  readonly name: string;
  readonly reason: 'too-large' | 'wrong-type' | 'too-many';
}

export interface FileDropzoneProps {
  readonly files: readonly DroppedFile[];
  readonly onFilesChange: (files: readonly DroppedFile[]) => void;
  /** Comma-separated `accept` list, e.g. `.json,application/json`. */
  readonly accept?: string;
  readonly multiple?: boolean;
  /** Offers a folder picker as well, and walks a dropped folder's contents. */
  readonly allowFolders?: boolean;
  readonly maxFiles?: number;
  readonly maxSizeBytes?: number;
  readonly disabled?: boolean;
  readonly description?: ReactNode;
  readonly onRejected?: (rejections: readonly FileRejection[]) => void;
  readonly className?: string;
}

function relativePathOf(file: File): string {
  const withPath = file as File & { readonly webkitRelativePath?: string };
  return withPath.webkitRelativePath !== undefined && withPath.webkitRelativePath !== ''
    ? withPath.webkitRelativePath
    : file.name;
}

function toDroppedFiles(files: readonly File[]): readonly DroppedFile[] {
  return files.map((file) => ({ file, relativePath: relativePathOf(file) }));
}

/* ------------------------- dropped folders, expanded --------------------- */

/** The non-standard entry API, typed rather than cast at every call. */
interface FileSystemEntryLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly fullPath: string;
  readonly name: string;
  file?: (onSuccess: (file: File) => void, onError: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      onSuccess: (entries: readonly FileSystemEntryLike[]) => void,
      onError: (error: unknown) => void,
    ) => void;
  };
}

function entryFile(entry: FileSystemEntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    if (entry.file === undefined) {
      resolve(null);
      return;
    }
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    );
  });
}

/** `readEntries` returns at most 100 at a time and must be called until it is empty. */
function readAllEntries(entry: FileSystemEntryLike): Promise<readonly FileSystemEntryLike[]> {
  const reader = entry.createReader?.();
  if (reader === undefined) return Promise.resolve([]);

  return new Promise((resolve) => {
    const collected: FileSystemEntryLike[] = [];
    const readBatch = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) {
            resolve(collected);
            return;
          }
          collected.push(...entries);
          readBatch();
        },
        () => resolve(collected),
      );
    };
    readBatch();
  });
}

async function walkEntry(entry: FileSystemEntryLike, into: DroppedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await entryFile(entry);
    if (file === null) return;
    // `fullPath` starts with a slash; the relative path never should.
    into.push({ file, relativePath: entry.fullPath.replace(/^\//, '') });
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readAllEntries(entry);
  for (const child of children) {
    await walkEntry(child, into);
  }
}

/**
 * Every file in a drop, with folder structure preserved. Falls back to
 * `dataTransfer.files` when the entry API is not available (Safari before 16.4,
 * and jsdom).
 */
export async function filesFromDataTransfer(
  dataTransfer: DataTransfer,
  { allowFolders }: { readonly allowFolders: boolean } = { allowFolders: true },
): Promise<readonly DroppedFile[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries: FileSystemEntryLike[] = [];

  if (allowFolders) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const withEntry = item as DataTransferItem & {
        webkitGetAsEntry?: () => FileSystemEntryLike | null;
      };
      const entry = withEntry.webkitGetAsEntry === undefined ? null : withEntry.webkitGetAsEntry();
      if (entry !== null && entry !== undefined) entries.push(entry);
    }
  }

  if (entries.length === 0) return toDroppedFiles(Array.from(dataTransfer.files));

  const collected: DroppedFile[] = [];
  for (const entry of entries) {
    await walkEntry(entry, collected);
  }
  return collected;
}

function matchesAccept(file: File, accept: string | undefined): boolean {
  if (accept === undefined || accept.trim() === '') return true;
  const patterns = accept
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();

  return patterns.some((pattern) => {
    if (pattern.startsWith('.')) return name.endsWith(pattern);
    if (pattern.endsWith('/*')) return type.startsWith(pattern.slice(0, -1));
    return type === pattern;
  });
}

export function FileDropzone({
  files,
  onFilesChange,
  accept,
  multiple = true,
  allowFolders = false,
  maxFiles,
  maxSizeBytes,
  disabled = false,
  description,
  onRejected,
  className,
}: FileDropzoneProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const inputId = useId();
  const folderInputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejections, setRejections] = useState<readonly FileRejection[]>([]);

  const accepted = useCallback(
    (incoming: readonly DroppedFile[]) => {
      const nextRejections: FileRejection[] = [];
      const nextFiles: DroppedFile[] = multiple ? [...files] : [];

      for (const dropped of incoming) {
        if (!matchesAccept(dropped.file, accept)) {
          nextRejections.push({ name: dropped.file.name, reason: 'wrong-type' });
          continue;
        }
        if (maxSizeBytes !== undefined && dropped.file.size > maxSizeBytes) {
          nextRejections.push({ name: dropped.file.name, reason: 'too-large' });
          continue;
        }
        if (maxFiles !== undefined && nextFiles.length >= maxFiles) {
          nextRejections.push({ name: dropped.file.name, reason: 'too-many' });
          continue;
        }
        nextFiles.push(dropped);
        if (!multiple) break;
      }

      setRejections(nextRejections);
      if (nextRejections.length > 0) onRejected?.(nextRejections);
      onFilesChange(nextFiles);
    },
    [accept, files, maxFiles, maxSizeBytes, multiple, onFilesChange, onRejected],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      if (disabled) return;
      void filesFromDataTransfer(event.dataTransfer, { allowFolders }).then((dropped) =>
        accepted(dropped),
      );
    },
    [accepted, allowFolders, disabled],
  );

  const remove = useCallback(
    (relativePath: string) => {
      onFilesChange(files.filter((entry) => entry.relativePath !== relativePath));
    },
    [files, onFilesChange],
  );

  const rejectionMessage = (rejection: FileRejection): string => {
    if (rejection.reason === 'too-large') {
      return t('form.dropzoneTooLarge', {
        name: rejection.name,
        limit: maxSizeBytes === undefined ? '' : format.bytes(maxSizeBytes),
      });
    }
    if (rejection.reason === 'too-many') {
      return t('form.dropzoneTooMany', { count: maxFiles ?? 0 });
    }
    return t('form.dropzoneWrongType', { name: rejection.name });
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div
        data-dragging={dragging}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors',
          'data-[dragging=true]:border-primary data-[dragging=true]:bg-primary/5',
          disabled && 'pointer-events-none opacity-60',
        )}
      >
        <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
          <UploadCloudIcon className="size-5" />
        </span>
        <p className="text-sm text-muted-foreground">
          {dragging ? (
            t('form.dropzoneActive')
          ) : (
            <>
              {t('form.dropzoneHint')}{' '}
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 align-baseline"
                onClick={() => inputRef.current?.click()}
              >
                {t('form.dropzoneBrowse')}
              </Button>
            </>
          )}
        </p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        {allowFolders ? (
          <>
            <p className="text-xs text-muted-foreground">{t('form.dropzoneFolderHint')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => folderInputRef.current?.click()}
            >
              <FolderUpIcon />
              {t('action.chooseFolder')}
            </Button>
          </>
        ) : null}
        {/*
          The one native file input in the app. It is visually hidden rather than
          `display: none` so the label association and keyboard activation still work.
        */}
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          className="sr-only"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={(event) => {
            accepted(toDroppedFiles(Array.from(event.target.files ?? [])));
            // Reset, so choosing the same file twice in a row still fires change.
            event.target.value = '';
          }}
        />
        <label htmlFor={inputId} className="sr-only">
          {multiple ? t('action.chooseFiles') : t('action.chooseFile')}
        </label>

        {allowFolders ? (
          <>
            {/*
              A second input, because `webkitdirectory` makes an input folder-only:
              one control cannot offer both files and a folder.
            */}
            <input
              ref={folderInputRef}
              id={folderInputId}
              type="file"
              className="sr-only"
              disabled={disabled}
              multiple
              // Non-standard, and the only way to offer a folder picker.
              {...{ webkitdirectory: '', directory: '' }}
              onChange={(event) => {
                accepted(toDroppedFiles(Array.from(event.target.files ?? [])));
                event.target.value = '';
              }}
            />
            <label htmlFor={folderInputId} className="sr-only">
              {t('action.chooseFolder')}
            </label>
          </>
        ) : null}
      </div>

      {rejections.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-destructive" role="alert">
          {rejections.map((rejection) => (
            <li key={`${rejection.name}-${rejection.reason}`}>{rejectionMessage(rejection)}</li>
          ))}
        </ul>
      ) : null}

      {files.length > 0 ? (
        <ul className="flex max-h-48 flex-col gap-1 overflow-auto">
          {files.map((entry) => (
            <li
              key={entry.relativePath}
              className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs"
            >
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="ltr-isolate min-w-0 flex-1 truncate font-mono">
                {entry.relativePath}
              </span>
              <Bytes value={entry.file.size} className="text-muted-foreground" />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('action.removeFile')}
                onClick={() => remove(entry.relativePath)}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
