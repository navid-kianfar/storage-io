import {
  MULTIPART_MAX_PARTS,
  MULTIPART_MIN_PART_SIZE,
  UPLOAD_HEADERS,
  type CompletedPart,
} from '@storage-io/contracts';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  listMultipartParts,
  multipartPartUrl,
} from '@/features/objects/api';
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
 * - **Small upload**: one `XMLHttpRequest` PUT per object to `…/objects/upload`.
 *   XHR rather than `fetch` because `fetch` still cannot report upload progress
 *   (request streams are not available everywhere and lose progress anyway), and
 *   progress is the whole point of this panel.
 * - **Large upload**: above the configured part size the object goes through the
 *   multipart endpoints, one `PUT …/multipart/:uploadId/parts/:n` at a time. This
 *   is what makes pause and resume real: the parts already stored stay stored, and
 *   resuming asks the server which ones those are (`GET …/multipart/:uploadId`)
 *   rather than trusting what this tab remembers. Progress does not go back to 0.
 * - **Download**: `fetch` plus a stream reader, which gives progress *and* a place
 *   to apply a bandwidth limit. The bytes are assembled into a Blob and handed to
 *   the browser to save.
 *
 * Failure budget: `Settings.transfers.retries` is the number of retries per part
 * ("0 means try once"), so a part is attempted `retries + 1` times. The same budget
 * covers a small upload and a download, which are one "part" each.
 *
 * Bandwidth: a download is paced while its body streams; a multipart upload is
 * paced *between* parts, because a part is one request the browser owns and there
 * is nowhere inside it to insert a wait.
 */

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PART_RETRIES = 4;
const DEFAULT_PART_SIZE_BYTES = 16 * 1024 * 1024;
const BYTES_IN_MB = 1024 * 1024;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8000;
/** One pacing wait is sliced this small so a pause is noticed while it waits. */
const PACING_SLICE_MS = 250;
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

/**
 * A multipart upload in progress. It survives a pause, which is the whole point:
 * `uploadId` is what lets the resume find the parts the server already holds.
 */
interface MultipartState {
  readonly uploadId: string;
  readonly partSizeBytes: number;
  /** The etag of every part the server has confirmed, by part number. */
  readonly etags: Map<number, string>;
  /** Bytes in those parts — the floor progress can never fall below. */
  storedBytes: number;
}

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
  /** Upload only, and only above the part size: the resumable upload's state. */
  multipart: MultipartState | null;
  lastBytes: number;
  lastAt: number;
  speed: number;
}

const tasks = new Map<string, Task>();
let concurrency = DEFAULT_CONCURRENCY;
let bandwidthLimitMbps: number | null = null;
let partRetries = DEFAULT_PART_RETRIES;
let configuredPartSizeBytes = DEFAULT_PART_SIZE_BYTES;
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
  /** `Settings.transfers.retries`: retries per part, so `retries + 1` attempts. */
  readonly retries?: number;
  /** `Settings.transfers.partSizeMb`: also the size above which an upload goes multipart. */
  readonly partSizeMb?: number;
}): void {
  if (options.parallel !== undefined && options.parallel >= 1) concurrency = options.parallel;
  if (options.bandwidthLimitMbps !== undefined) bandwidthLimitMbps = options.bandwidthLimitMbps;
  if (options.retries !== undefined && options.retries >= 0) partRetries = options.retries;
  if (options.partSizeMb !== undefined && options.partSizeMb > 0) {
    // S3's own floor, restated: a part below 5 MiB is rejected, so a smaller
    // setting would produce an upload that cannot complete.
    configuredPartSizeBytes = Math.max(MULTIPART_MIN_PART_SIZE, options.partSizeMb * BYTES_IN_MB);
  }
  pump();
}

export function engineConcurrency(): number {
  return concurrency;
}

/** Attempts per part, including the first. */
function maxAttempts(): number {
  return partRetries + 1;
}

/** Above this an upload is multipart, and pause/resume is a real resume. */
export function multipartThresholdBytes(): number {
  return configuredPartSizeBytes;
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
      multipart: null,
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
    multipart: null,
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
  // A multipart upload keeps what the server already holds; the part that was in
  // flight is gone, so the bar falls back to the last confirmed part rather than
  // claiming bytes that were thrown away.
  store().update(id, {
    status: 'paused',
    bytesPerSecond: 0,
    etaSeconds: null,
    ...(task.multipart === null ? {} : { transferredBytes: task.multipart.storedBytes }),
  });
  pump();
}

export function resumeTransfer(id: string): void {
  const task = tasks.get(id);
  if (task === undefined) return;
  // A multipart upload resumes from its stored parts. A single PUT or GET has no
  // resume point, so that object starts again.
  const resumedBytes = task.multipart?.storedBytes ?? 0;
  task.lastBytes = resumedBytes;
  task.speed = 0;
  store().update(id, { status: 'queued', transferredBytes: resumedBytes, error: null });
  pump();
}

export function cancelTransfer(id: string): void {
  const task = tasks.get(id);
  if (task !== undefined) {
    task.stopping = 'cancel';
    stopRequest(task);
    discardMultipart(task);
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
  const resumedBytes = task.multipart?.storedBytes ?? 0;
  task.lastBytes = resumedBytes;
  task.speed = 0;
  store().update(id, {
    status: 'queued',
    transferredBytes: resumedBytes,
    error: null,
    attempt: 0,
  });
  pump();
}

/** Drops a finished or cancelled row; an active one is cancelled first. */
export function removeTransfer(id: string): void {
  const task = tasks.get(id);
  if (task !== undefined) {
    task.stopping = 'cancel';
    stopRequest(task);
    discardMultipart(task);
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
  if (retryable && task.attempt < maxAttempts()) {
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

/**
 * One object. Above the configured part size it goes through the multipart
 * endpoints, which is the only way a pause can be resumed rather than restarted.
 */
function runUpload(task: Task): Promise<void> {
  const file = task.file;
  const options = task.uploadOptions;
  if (file === undefined || options === undefined) {
    fail(task, 'missing file', false);
    return Promise.resolve();
  }
  if (file.size > multipartThresholdBytes()) return runMultipartUpload(task, file, options);
  return runSingleUpload(task, file, options);
}

function runSingleUpload(
  task: Task,
  file: File,
  options: Omit<UploadRequest, 'items' | 'scope'>,
): Promise<void> {
  return new Promise((resolve) => {
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

/* ---------------------------- multipart upload ---------------------------- */

/** What one part attempt came back with. */
type PartOutcome =
  | { readonly kind: 'ok'; readonly etag: string; readonly size: number }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'error'; readonly message: string; readonly retryable: boolean };

function objectScope(task: Task): { readonly serverId: string; readonly bucket: string } {
  return { serverId: task.scope.serverId, bucket: task.scope.bucket };
}

function transferStatus(id: string): Transfer['status'] | undefined {
  return store().transfers.find((transfer) => transfer.id === id)?.status;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * A resumable upload.
 *
 * The first run creates the upload; every later run asks the server which parts it
 * already holds and sends only the rest. That question is the difference between a
 * resume and a restart: this tab may have been reloaded, and the parts the server
 * has are the only ones that count.
 */
async function runMultipartUpload(
  task: Task,
  file: File,
  options: Omit<UploadRequest, 'items' | 'scope'>,
): Promise<void> {
  const scope = objectScope(task);
  try {
    const state = await openOrResume(task, file, options);
    const partCount = Math.max(1, Math.ceil(file.size / state.partSizeBytes));
    if (partCount > MULTIPART_MAX_PARTS) {
      fail(task, `the file needs ${String(partCount)} parts; the limit is ${String(MULTIPART_MAX_PARTS)}`, false);
      return;
    }

    onProgress(task, state.storedBytes);

    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      if (state.etags.has(partNumber)) continue;
      if (transferStatus(task.id) !== 'running') return;

      const start = (partNumber - 1) * state.partSizeBytes;
      const chunk = file.slice(start, Math.min(start + state.partSizeBytes, file.size));
      const partStartedAt = Date.now();
      const sent = await sendPart(task, state, partNumber, chunk);
      if (sent !== 'done') return;

      // Pacing belongs between parts: a part is one request the browser owns and
      // there is nowhere inside it to insert a wait.
      const paced = await pacePart(task, chunk.size, partStartedAt);
      if (!paced) return;
    }

    const parts: readonly CompletedPart[] = [...state.etags]
      .map(([partNumber, etag]) => ({ partNumber, etag }))
      .sort((left, right) => left.partNumber - right.partNumber);
    await completeMultipartUpload(scope, state.uploadId, task.key, { parts: [...parts] });
    finish(task);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    // Creating, listing or completing failed. The parts already stored stay on the
    // server, so a retry resumes rather than starting over.
    fail(task, errorMessage(error), false);
  }
}

async function openOrResume(
  task: Task,
  file: File,
  options: Omit<UploadRequest, 'items' | 'scope'>,
): Promise<MultipartState> {
  const scope = objectScope(task);
  const existing = task.multipart;

  if (existing === null) {
    const created = await createMultipartUpload(scope, {
      key: task.key,
      contentType: uploadContentType(file, options),
      metadata: { ...(options.metadata ?? {}) },
      tags: { ...(options.tags ?? {}) },
      storageClass: options.storageClass ?? null,
    });
    const opened: MultipartState = {
      uploadId: created.uploadId,
      partSizeBytes: created.partSizeBytes,
      etags: new Map(),
      storedBytes: 0,
    };
    task.multipart = opened;
    return opened;
  }

  const held = await listMultipartParts(scope, existing.uploadId, task.key);
  existing.etags.clear();
  existing.storedBytes = 0;
  for (const part of held.parts) {
    existing.etags.set(part.partNumber, part.etag);
    existing.storedBytes += part.size;
  }
  return existing;
}

/**
 * One part, with the retry budget from `Settings.transfers.retries`. A 4xx is not
 * retried: the same bytes at the same URL will be refused the same way.
 */
async function sendPart(
  task: Task,
  state: MultipartState,
  partNumber: number,
  chunk: Blob,
): Promise<'done' | 'stopped' | 'failed'> {
  const attempts = maxAttempts();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    task.attempt = attempt;
    store().update(task.id, { attempt });
    const outcome = await putPart(task, state, partNumber, chunk);

    if (outcome.kind === 'ok') {
      state.etags.set(partNumber, outcome.etag);
      state.storedBytes += outcome.size;
      onProgress(task, state.storedBytes);
      store().update(task.id, { error: null });
      return 'done';
    }
    if (outcome.kind === 'stopped') return 'stopped';
    if (!outcome.retryable || attempt === attempts) {
      fail(task, outcome.message, false);
      return 'failed';
    }

    store().update(task.id, { error: outcome.message, bytesPerSecond: 0, etaSeconds: null });
    // The failed part's partial bytes are gone; show what is actually stored.
    onProgress(task, state.storedBytes);
    await sleep(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)));
    if (transferStatus(task.id) !== 'running') return 'stopped';
  }
  return 'failed';
}

/**
 * The part itself. XHR, for the same reason the single PUT uses it: progress. The
 * body is a `Blob`, so the browser sets the `Content-Length` the API requires.
 */
function putPart(
  task: Task,
  state: MultipartState,
  partNumber: number,
  chunk: Blob,
): Promise<PartOutcome> {
  return new Promise((resolve) => {
    const url = multipartPartUrl(objectScope(task), state.uploadId, partNumber, task.key);
    const xhr = new XMLHttpRequest();
    task.xhr = xhr;
    xhr.open('PUT', url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      onProgress(task, state.storedBytes + event.loaded);
    });

    xhr.addEventListener('load', () => {
      task.xhr = null;
      if (xhr.status < 200 || xhr.status >= HTTP_SERVER_ERROR) {
        resolve({ kind: 'error', message: problemMessageFrom(xhr), retryable: true });
        return;
      }
      if (xhr.status >= 300) {
        resolve({ kind: 'error', message: problemMessageFrom(xhr), retryable: false });
        return;
      }
      const parsed = parsePartResponse(xhr.responseText);
      if (parsed === null) {
        resolve({ kind: 'error', message: 'the part response could not be read', retryable: true });
        return;
      }
      resolve({ kind: 'ok', etag: parsed.etag, size: parsed.size });
    });

    xhr.addEventListener('error', () => {
      task.xhr = null;
      resolve({ kind: 'error', message: 'network error', retryable: true });
    });

    xhr.addEventListener('abort', () => {
      task.xhr = null;
      resolve({ kind: 'stopped' });
    });

    xhr.send(chunk);
  });
}

function parsePartResponse(text: string): { readonly etag: string; readonly size: number } | null {
  try {
    const parsed = JSON.parse(text) as { etag?: unknown; size?: unknown };
    if (typeof parsed.etag !== 'string' || parsed.etag === '') return null;
    const size = typeof parsed.size === 'number' ? parsed.size : 0;
    return { etag: parsed.etag, size };
  } catch {
    return null;
  }
}

/**
 * Holds the upload back to the configured megabits per second between parts.
 * Returns false when the operator paused or cancelled while it waited, so the
 * caller stops instead of sending the next part.
 */
async function pacePart(task: Task, bytes: number, startedAt: number): Promise<boolean> {
  if (bandwidthLimitMbps === null || bandwidthLimitMbps <= 0) return true;
  const bytesPerSecond = (bandwidthLimitMbps * 1_000_000) / BITS_PER_BYTE;
  const shouldHaveTakenMs = (bytes / bytesPerSecond) * MS_IN_SECOND;
  const actualMs = Date.now() - startedAt;
  let remaining = shouldHaveTakenMs - actualMs;

  while (remaining > 0) {
    await sleep(Math.min(PACING_SLICE_MS, remaining));
    if (transferStatus(task.id) !== 'running') return false;
    remaining -= PACING_SLICE_MS;
  }
  return true;
}

/**
 * Throws away a cancelled upload's parts, so they do not sit on the server until
 * the `keepIncompleteDays` lifecycle rule collects them. Its failure is reported
 * rather than swallowed, but it never changes the cancel the operator asked for.
 */
function discardMultipart(task: Task): void {
  const state = task.multipart;
  if (state === null) return;
  task.multipart = null;
  abortMultipartUpload(objectScope(task), state.uploadId, task.key).catch((error: unknown) => {
    console.warn(`[transfers] the upload of "${task.key}" was cancelled but its parts remain: ${errorMessage(error)}`);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'the request failed';
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
