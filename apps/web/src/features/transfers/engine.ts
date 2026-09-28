import { UPLOAD_HEADERS } from '@storage-io/contracts';
import { buildUrl } from '@/lib/api/client';
import { downloadBlob } from '@/lib/csv';
import { useTransfers, type Transfer, type TransferDirection } from '@/stores/transfers';

/**
 * The browser-side transfer engine.
 *
 * It is a module singleton rather than a hook, on purpose: an upload has to keep
 * running when the operator navigates away from the object browser, and a hook dies
 * with its component. The only state it owns is the in-flight request per
 * transfer; everything the UI reads lives in the zustand store.
 *
 * How each direction works:
 *
 * - **Upload**: one `XMLHttpRequest` PUT per object to `…/objects/upload`. XHR
 *   rather than `fetch` because `fetch` still cannot report upload progress
 *   (request streams are not available everywhere and lose progress anyway), and
 *   progress is the whole point of this panel.
 * - **Download**: `fetch` plus a stream reader, which gives progress *and* a place
 *   to apply a bandwidth limit. The bytes are assembled into a Blob and handed to
 *   the browser to save.
 *
 * Pause, honestly: a single PUT cannot be resumed from the middle, so pausing an
 * upload aborts it and resuming starts that object again from zero. The UI shows
 * the progress going back to 0, because that is what happens. Resumable uploads
 * need the multipart endpoints, which the contract does not expose to the browser.
 */

const DEFAULT_CONCURRENCY = 4;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8000;
const SPEED_SMOOTHING = 0.3;
const SAMPLE_INTERVAL_MS = 5000;
const DOWNLOAD_CHUNK_TARGET = 64 * 1024;
const BITS_PER_BYTE = 8;
const MS_IN_SECOND = 1000;
const HTTP_SERVER_ERROR = 500;
const HTTP_CONFLICT = 409;

export interface TransferScope {
  readonly serverId: string;
  readonly serverName: string;
  readonly bucket: string;
}

export interface UploadItem {
  readonly file: File;
  /** The path inside the dropped folder, so a folder upload keeps its shape. */
  readonly relativePath: string;
}

export interface UploadRequest {
  readonly scope: TransferScope;
  readonly items: readonly UploadItem[];
  /** Where the files land; `''` is the bucket root. Must end with `/` when set. */
  readonly destPrefix: string;
  readonly storageClass?: string | null;
  readonly overwrite: boolean;
  /** Sends a `Content-Type` guessed from the extension when the File has none. */
  readonly detectContentType: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly tags?: Readonly<Record<string, string>>;
  /** Used for the guessed content type, injected so the engine stays framework-free. */
  readonly guessContentType?: (name: string) => string | null;
}

export interface DownloadRequest {
  readonly scope: TransferScope;
  readonly key: string;
  readonly sizeBytes: number;
  readonly versionId?: string;
  /** The name the file is saved under; defaults to the key's last segment. */
  readonly fileName?: string;
}

type TaskKind = 'upload' | 'download';

interface Task {
  readonly id: string;
  readonly kind: TaskKind;
  readonly scope: TransferScope;
  readonly key: string;
  readonly totalBytes: number;
  /** Upload only. */
  readonly file?: File;
  readonly uploadOptions?: Omit<UploadRequest, 'items' | 'scope'>;
  /** Download only. */
  readonly versionId?: string;
  readonly fileName?: string;
  attempt: number;
  xhr: XMLHttpRequest | null;
  abort: AbortController | null;
  /** Set while a pause or cancel is being carried out, so the abort is not a failure. */
  stopping: 'pause' | 'cancel' | null;
  lastBytes: number;
  lastAt: number;
  speed: number;
}

const tasks = new Map<string, Task>();
let concurrency = DEFAULT_CONCURRENCY;
let bandwidthLimitMbps: number | null = null;
let sampleTimer: number | null = null;
let nextId = 0;

function makeId(kind: TaskKind): string {
  nextId += 1;
  return `${kind}-${String(Date.now())}-${String(nextId)}`;
}

const store = () => useTransfers.getState();

/* ---------------------------- settings from Settings --------------------- */

/** Called by the pages that own `Settings.transfers`, so one setting has one home. */
export function configureEngine(options: {
  readonly parallel?: number;
  readonly bandwidthLimitMbps?: number | null;
}): void {
  if (options.parallel !== undefined && options.parallel >= 1) concurrency = options.parallel;
  if (options.bandwidthLimitMbps !== undefined) bandwidthLimitMbps = options.bandwidthLimitMbps;
  pump();
}

export function engineConcurrency(): number {
  return concurrency;
}

/* ------------------------------- public API ----------------------------- */

export function enqueueUploads(payload: UploadRequest): readonly string[] {
  const { scope, items, ...options } = payload;
  const ids: string[] = [];

  for (const item of items) {
    const relative = item.relativePath === '' ? item.file.name : item.relativePath;
    const key = `${options.destPrefix}${relative}`;
    const id = makeId('upload');
    tasks.set(id, {
      id,
      kind: 'upload',
      scope,
      key,
      totalBytes: item.file.size,
      file: item.file,
      uploadOptions: options,
      attempt: 0,
      xhr: null,
      abort: null,
      stopping: null,
      lastBytes: 0,
      lastAt: 0,
      speed: 0,
    });
    store().add(newTransfer(id, 'upload', scope, key, item.file.size));
    ids.push(id);
  }

  startSampling();
  pump();
  return ids;
}

export function enqueueDownload(payload: DownloadRequest): string {
  const id = makeId('download');
  tasks.set(id, {
    id,
    kind: 'download',
    scope: payload.scope,
    key: payload.key,
    totalBytes: payload.sizeBytes,
    versionId: payload.versionId,
    fileName: payload.fileName,
    attempt: 0,
    xhr: null,
    abort: null,
    stopping: null,
    lastBytes: 0,
    lastAt: 0,
    speed: 0,
  });
  store().add(newTransfer(id, 'download', payload.scope, payload.key, payload.sizeBytes));
  startSampling();
  pump();
  return id;
}

/** Adds a completed entry for a transfer the browser did itself (a ZIP, a preview). */
export function recordCompletedDownload(
  scope: TransferScope,
  key: string,
  sizeBytes: number,
): void {
  const id = makeId('download');
  const now = new Date().toISOString();
  store().add({
    ...newTransfer(id, 'download', scope, key, sizeBytes),
    transferredBytes: sizeBytes,
    status: 'completed',
    finishedAt: now,
  });
  store().countFinished('download', sizeBytes);
}

export function pauseTransfer(id: string): void {
  const task = tasks.get(id);
  if (task === undefined) return;
  task.stopping = 'pause';
  stopRequest(task);
  task.stopping = null;
  store().update(id, { status: 'paused', bytesPerSecond: 0, etaSeconds: null });
  pump();
}

export function resumeTransfer(id: string): void {
  const task = tasks.get(id);
  if (task === undefined) return;
  // A single PUT/GET has no resume point, so the object starts again.
  task.lastBytes = 0;
  task.speed = 0;
  store().update(id, { status: 'queued', transferredBytes: 0, error: null });
  pump();
}

export function cancelTransfer(id: string): void {
  const task = tasks.get(id);
  if (task !== undefined) {
    task.stopping = 'cancel';
    stopRequest(task);
    tasks.delete(id);
  }
  store().update(id, {
    status: 'cancelled',
    bytesPerSecond: 0,
    etaSeconds: null,
    finishedAt: new Date().toISOString(),
  });
  pump();
}

export function retryTransfer(id: string): void {
  const task = tasks.get(id);
  if (task === undefined) return;
  task.attempt = 0;
  task.lastBytes = 0;
  task.speed = 0;
  store().update(id, { status: 'queued', transferredBytes: 0, error: null, attempt: 0 });
  pump();
}

/** Drops a finished or cancelled row; an active one is cancelled first. */
export function removeTransfer(id: string): void {
  const task = tasks.get(id);
  if (task !== undefined) {
    task.stopping = 'cancel';
    stopRequest(task);
    tasks.delete(id);
  }
  store().remove(id);
  pump();
}

export function pauseAllTransfers(): void {
  for (const transfer of store().transfers) {
    if (transfer.status !== 'running' && transfer.status !== 'queued') continue;
    pauseTransfer(transfer.id);
  }
}

export function resumeAllTransfers(): void {
  for (const transfer of store().transfers) {
    if (transfer.status !== 'paused') continue;
    resumeTransfer(transfer.id);
  }
}

export function clearCompletedTransfers(): void {
  for (const transfer of store().transfers) {
    if (transfer.status === 'completed' || transfer.status === 'cancelled') tasks.delete(transfer.id);
  }
  store().clearCompleted();
}

/* -------------------------------- internals ----------------------------- */

function newTransfer(
  id: string,
  direction: TransferDirection,
  scope: TransferScope,
  key: string,
  totalBytes: number,
): Transfer {
  const lastSlash = key.lastIndexOf('/');
  return {
    id,
    direction,
    name: lastSlash === -1 ? key : key.slice(lastSlash + 1),
    serverId: scope.serverId,
    serverName: scope.serverName,
    bucket: scope.bucket,
    key,
    totalBytes,
    transferredBytes: 0,
    status: 'queued',
    bytesPerSecond: 0,
    etaSeconds: null,
    error: null,
    attempt: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

function stopRequest(task: Task): void {
  task.xhr?.abort();
  task.xhr = null;
  task.abort?.abort();
  task.abort = null;
}

function runningCount(): number {
  return store().transfers.filter((transfer) => transfer.status === 'running').length;
}

/** Starts queued transfers until the concurrency limit is reached. */
function pump(): void {
  let slots = concurrency - runningCount();
  if (slots <= 0) return;

  for (const transfer of store().transfers) {
    if (slots <= 0) break;
    if (transfer.status !== 'queued') continue;
    const task = tasks.get(transfer.id);
    if (task === undefined) continue;
    slots -= 1;
    void start(task);
  }
}

function start(task: Task): Promise<void> {
  task.attempt += 1;
  task.lastAt = Date.now();
  task.lastBytes = task.lastBytes > 0 ? task.lastBytes : 0;
  store().update(task.id, { status: 'running', error: null, attempt: task.attempt });
  return task.kind === 'upload' ? runUpload(task) : runDownload(task);
}

function onProgress(task: Task, loaded: number): void {
  const now = Date.now();
  const elapsed = (now - task.lastAt) / MS_IN_SECOND;
  if (elapsed > 0) {
    const instant = Math.max(0, loaded - task.lastBytes) / elapsed;
    task.speed = task.speed === 0 ? instant : task.speed * (1 - SPEED_SMOOTHING) + instant * SPEED_SMOOTHING;
    task.lastAt = now;
    task.lastBytes = loaded;
  }
  const remaining = Math.max(0, task.totalBytes - loaded);
  store().update(task.id, {
    transferredBytes: loaded,
    bytesPerSecond: Math.round(task.speed),
    etaSeconds: task.speed > 0 && task.totalBytes > 0 ? Math.round(remaining / task.speed) : null,
  });
}

function finish(task: Task): void {
  store().update(task.id, {
    status: 'completed',
    transferredBytes: task.totalBytes,
    bytesPerSecond: 0,
    etaSeconds: null,
    error: null,
    finishedAt: new Date().toISOString(),
  });
  store().countFinished(task.kind === 'upload' ? 'upload' : 'download', task.totalBytes);
  tasks.delete(task.id);
  pump();
}

/** A transient failure is retried with backoff; a 4xx is reported as it is. */
function fail(task: Task, message: string, retryable: boolean): void {
  if (retryable && task.attempt < MAX_ATTEMPTS) {
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (task.attempt - 1));
    store().update(task.id, {
      status: 'queued',
      bytesPerSecond: 0,
      etaSeconds: null,
      error: message,
      transferredBytes: 0,
    });
    task.lastBytes = 0;
    task.speed = 0;
    window.setTimeout(() => {
      // The operator may have paused or cancelled it while it waited.
      const current = store().transfers.find((transfer) => transfer.id === task.id);
      if (current?.status !== 'queued') return;
      pump();
    }, delay);
    return;
  }

  store().update(task.id, {
    status: 'failed',
    bytesPerSecond: 0,
    etaSeconds: null,
    error: message,
    finishedAt: new Date().toISOString(),
  });
  pump();
}

/* --------------------------------- upload -------------------------------- */

function runUpload(task: Task): Promise<void> {
  return new Promise((resolve) => {
    const file = task.file;
    const options = task.uploadOptions;
    if (file === undefined || options === undefined) {
      fail(task, 'missing file', false);
      resolve();
      return;
    }

    const url = buildUrl(
      `/servers/${encodeURIComponent(task.scope.serverId)}/buckets/${encodeURIComponent(task.scope.bucket)}/objects/upload`,
      { key: task.key, overwrite: options.overwrite },
    );

    const xhr = new XMLHttpRequest();
    task.xhr = xhr;
    xhr.open('PUT', url, true);
    xhr.withCredentials = true;

    const contentType = uploadContentType(file, options);
    if (contentType !== null) xhr.setRequestHeader('Content-Type', contentType);
    if (options.storageClass != null && options.storageClass !== '') {
      xhr.setRequestHeader(UPLOAD_HEADERS.storageClass, options.storageClass);
    }
    const tags = options.tags ?? {};
    if (Object.keys(tags).length > 0) {
      xhr.setRequestHeader(UPLOAD_HEADERS.tags, encodeTagHeader(tags));
    }
    for (const [name, value] of Object.entries(options.metadata ?? {})) {
      // Header values must be latin-1; anything else is percent-encoded, which is
      // what S3 itself does with non-ASCII user metadata.
      xhr.setRequestHeader(`${UPLOAD_HEADERS.metaPrefix}${name}`, encodeURIComponent(value));
    }

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      onProgress(task, event.loaded);
    });

    xhr.addEventListener('load', () => {
      task.xhr = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(task);
        resolve();
        return;
      }
      const message = problemMessageFrom(xhr);
      // A 409 means the key exists and `overwrite` was off: retrying changes nothing.
      fail(task, message, xhr.status >= HTTP_SERVER_ERROR && xhr.status !== HTTP_CONFLICT);
      resolve();
    });

    xhr.addEventListener('error', () => {
      task.xhr = null;
      fail(task, 'network error', true);
      resolve();
    });

    xhr.addEventListener('abort', () => {
      task.xhr = null;
      // A pause or a cancel already set the status; nothing to report.
      resolve();
    });

    xhr.send(file);
  });
}

function uploadContentType(file: File, options: Omit<UploadRequest, 'items' | 'scope'>): string | null {
  if (file.type !== '') return file.type;
  if (!options.detectContentType) return null;
  return options.guessContentType?.(file.name) ?? null;
}

/** `X-Sio-Tags` carries a urlencoded query string, as S3's own tagging header does. */
export function encodeTagHeader(tags: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(tags)) params.append(key, value);
  return params.toString();
}

function problemMessageFrom(xhr: XMLHttpRequest): string {
  try {
    const parsed = JSON.parse(xhr.responseText) as { detail?: unknown; title?: unknown };
    if (typeof parsed.detail === 'string' && parsed.detail !== '') return parsed.detail;
    if (typeof parsed.title === 'string' && parsed.title !== '') return parsed.title;
  } catch {
    // Not problem+json; the status line is all there is.
  }
  return `HTTP ${String(xhr.status)}`;
}

/* -------------------------------- download ------------------------------- */

async function runDownload(task: Task): Promise<void> {
  const controller = new AbortController();
  task.abort = controller;

  const url = buildUrl(
    `/servers/${encodeURIComponent(task.scope.serverId)}/buckets/${encodeURIComponent(task.scope.bucket)}/objects/download`,
    { key: task.key, versionId: task.versionId },
  );

  try {
    const response = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!response.ok) {
      const retryable = response.status >= HTTP_SERVER_ERROR;
      fail(task, `HTTP ${String(response.status)}`, retryable);
      return;
    }

    const declared = response.headers.get('content-length');
    const total = declared === null ? task.totalBytes : Number.parseInt(declared, 10);
    const chunks = await readWithProgress(task, response, Number.isFinite(total) ? total : 0);
    if (chunks === null) return;

    const blob = new Blob([...chunks], {
      type: response.headers.get('content-type') ?? 'application/octet-stream',
    });
    const lastSlash = task.key.lastIndexOf('/');
    downloadBlob(task.fileName ?? (lastSlash === -1 ? task.key : task.key.slice(lastSlash + 1)), blob);
    finish(task);
  } catch (error) {
    task.abort = null;
    if (error instanceof DOMException && error.name === 'AbortError') return;
    fail(task, error instanceof Error ? error.message : 'network error', true);
  }
}

/**
 * Reads the body chunk by chunk so progress is real, and paces it when a bandwidth
 * limit is set. `null` means the read was aborted and the status is already set.
 */
async function readWithProgress(
  task: Task,
  response: Response,
  total: number,
): Promise<readonly BlobPart[] | null> {
  const body = response.body;
  if (body === null) {
    const blob = await response.blob();
    onProgress(task, blob.size);
    return [blob];
  }

  const reader = body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  const startedAt = Date.now();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(task, loaded);
    await throttle(loaded, startedAt);
  }

  if (total > 0 && loaded !== total) {
    // A truncated body is a failure, not a completed download of a broken file.
    fail(task, 'the download ended early', true);
    return null;
  }
  return chunks;
}

/**
 * Holds the stream back to the configured megabits per second. `bandwidthLimitMbps`
 * is a per-transfer pace: with a limit of 10 and four parallel downloads the total
 * is up to 40, which is how every download manager reads that setting.
 */
async function throttle(loaded: number, startedAt: number): Promise<void> {
  if (bandwidthLimitMbps === null || bandwidthLimitMbps <= 0) return;
  const bytesPerSecond = (bandwidthLimitMbps * 1_000_000) / BITS_PER_BYTE;
  const expectedMs = (loaded / bytesPerSecond) * MS_IN_SECOND;
  const elapsedMs = Date.now() - startedAt;
  const waitMs = expectedMs - elapsedMs;
  if (waitMs < DOWNLOAD_CHUNK_TARGET / bytesPerSecond) return;
  await new Promise((resolve) => window.setTimeout(resolve, Math.min(waitMs, MS_IN_SECOND)));
}

/* ------------------------------ chart samples ---------------------------- */

/**
 * One throughput sample every 5 s while anything is moving. The timer stops when
 * the queue goes quiet so an idle tab is not waking up forever.
 */
function startSampling(): void {
  if (sampleTimer !== null) return;
  sampleTimer = window.setInterval(() => {
    const transfers = store().transfers;
    let up = 0;
    let down = 0;
    let active = 0;
    for (const transfer of transfers) {
      if (transfer.status !== 'running') continue;
      active += 1;
      if (transfer.direction === 'upload') up += transfer.bytesPerSecond;
      else down += transfer.bytesPerSecond;
    }
    store().sample({ t: Date.now(), up, down });
    if (active > 0) return;
    const stillQueued = transfers.some(
      (transfer) => transfer.status === 'queued' || transfer.status === 'paused',
    );
    if (stillQueued) return;
    if (sampleTimer !== null) window.clearInterval(sampleTimer);
    sampleTimer = null;
  }, SAMPLE_INTERVAL_MS);
}
