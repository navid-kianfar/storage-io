import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  FilmIcon,
  FolderIcon,
  ImageIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * What kind of thing an object is, for the icon, the filter and the preview.
 *
 * The content type wins when the server sent one, because it is what the browser
 * will act on; the extension is the fallback, and the only signal available for a
 * listing entry (`ObjectItem` has no content type — only `meta` does).
 */

export const FILE_KINDS = [
  'folder',
  'image',
  'video',
  'audio',
  'pdf',
  'text',
  'archive',
  'other',
] as const;

export type FileKind = (typeof FILE_KINDS)[number];

/** Extension → content type, for the upload dialog's "detect Content-Type". */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',

  avi: 'video/x-msvideo',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  webm: 'video/webm',

  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',

  pdf: 'application/pdf',

  css: 'text/css',
  csv: 'text/csv',
  html: 'text/html',
  js: 'text/javascript',
  json: 'application/json',
  log: 'text/plain',
  md: 'text/markdown',
  sql: 'text/plain',
  toml: 'text/plain',
  ts: 'text/plain',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',

  '7z': 'application/x-7z-compressed',
  bz2: 'application/x-bzip2',
  gz: 'application/gzip',
  rar: 'application/vnd.rar',
  tar: 'application/x-tar',
  zip: 'application/zip',
  zst: 'application/zstd',
};

const ARCHIVE_TYPES = new Set([
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/zstd',
  'application/x-7z-compressed',
  'application/x-bzip2',
  'application/vnd.rar',
]);

const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-ndjson',
  'application/javascript',
]);

export function extensionOf(name: string): string {
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === name.length - 1) return '';
  return name.slice(lastDot + 1).toLowerCase();
}

/** The content type for a file about to be uploaded, or null when unknown. */
export function guessContentType(name: string): string | null {
  const extension = extensionOf(name);
  return CONTENT_TYPES[extension] ?? null;
}

export function fileKind(key: string, contentType?: string | null): FileKind {
  if (key.endsWith('/')) return 'folder';

  const type = (contentType ?? guessContentType(key) ?? '').toLowerCase();
  const base = type.split(';')[0] ?? '';

  // SVG is markup with scripts and external references, not a picture: the API
  // serves it as an attachment for that reason, so it is previewed as source in
  // the read-only code view rather than rendered.
  if (base === 'image/svg+xml') return 'text';
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('video/')) return 'video';
  if (base.startsWith('audio/')) return 'audio';
  if (base === 'application/pdf') return 'pdf';
  if (ARCHIVE_TYPES.has(base)) return 'archive';
  if (base.startsWith('text/') || TEXT_TYPES.has(base)) return 'text';
  return 'other';
}

export const KIND_ICONS: Readonly<Record<FileKind, LucideIcon>> = {
  folder: FolderIcon,
  image: ImageIcon,
  video: FilmIcon,
  audio: FileAudioIcon,
  pdf: FileTextIcon,
  text: FileCodeIcon,
  archive: FileArchiveIcon,
  other: FileIcon,
};

/** The concept's per-kind icon tints (`.ficon.k-*`), as token-based classes. */
export const KIND_TINTS: Readonly<Record<FileKind, string>> = {
  folder: 'bg-primary/12 text-primary',
  image: 'bg-chart-3/15 text-chart-3',
  video: 'bg-chart-5/15 text-chart-5',
  audio: 'bg-chart-4/18 text-warning-foreground',
  pdf: 'bg-destructive/12 text-destructive',
  text: 'bg-chart-2/15 text-chart-2',
  archive: 'bg-warning/18 text-warning-foreground',
  other: 'bg-muted text-muted-foreground',
};

/** Which CodeEditor language a text object should be highlighted with. */
export function editorLanguage(key: string): 'json' | 'markdown' | 'plain' {
  const extension = extensionOf(key);
  if (extension === 'json') return 'json';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  return 'plain';
}

/**
 * Editing and text preview happen in the browser, so there is a ceiling. 2 MB is
 * generous for a config file or a copy deck and small enough that CodeMirror stays
 * responsive.
 */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** An inline image/video/audio preview is fetched in full, so it has a ceiling too. */
export const MEDIA_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;
