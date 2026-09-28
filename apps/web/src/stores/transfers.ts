import { create } from 'zustand';

/**
 * The browser-side transfer queue.
 *
 * Uploads and downloads run in this tab (XHR, for upload progress), so their
 * state cannot live in TanStack Query — it is not server state. This store is the
 * single source for the topbar's transfers popover, the /transfers page and the
 * object browser's floating upload panel, and `src/features/transfers/engine.ts`
 * is the only thing that writes to it.
 *
 * Progress updates land many times a second, so the store is deliberately flat
 * and selectors are narrow: subscribe to `counts` in the topbar rather than to the
 * whole list.
 */

export type TransferDirection = 'upload' | 'download';

export type TransferStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface Transfer {
  readonly id: string;
  readonly direction: TransferDirection;
  /** The file name, as shown in the list. */
  readonly name: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly bucket: string;
  /**
   * The bucket's opaque id, so "open location" can build a route: every URL in
   * the app is addressed by id, and a bucket name is not one.
   */
  readonly bucketId: string;
  /** The full object key, so "open location" knows which folder to go to. */
  readonly key: string;
  readonly totalBytes: number;
  readonly transferredBytes: number;
  readonly status: TransferStatus;
  readonly bytesPerSecond: number;
  /** Seconds remaining at the current speed, or null when it cannot be known. */
  readonly etaSeconds: number | null;
  readonly error: string | null;
  /** How many attempts this transfer has taken, including the one in flight. */
  readonly attempt: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface TransferCounts {
  readonly uploading: number;
  readonly downloading: number;
  readonly active: number;
  readonly queued: number;
  readonly failed: number;
  readonly completed: number;
}

/** One point of the throughput chart: bytes per second in each direction. */
export interface ThroughputSample {
  readonly t: number;
  readonly up: number;
  readonly down: number;
}

const ACTIVE_STATUSES: readonly TransferStatus[] = ['queued', 'running', 'paused'];

/** 10 minutes at one sample every 5 s, which is what the concept's chart shows. */
export const THROUGHPUT_WINDOW = 120;

export interface TransferTotals {
  readonly uploadedBytes: number;
  readonly downloadedBytes: number;
  readonly completed: number;
}

interface TransfersState {
  readonly transfers: readonly Transfer[];
  readonly throughput: readonly ThroughputSample[];
  readonly totals: TransferTotals;
  add: (transfer: Transfer) => void;
  update: (id: string, patch: Partial<Omit<Transfer, 'id'>>) => void;
  remove: (id: string) => void;
  clearCompleted: () => void;
  pauseAll: () => void;
  resumeAll: () => void;
  /** Records one chart sample and rolls the window. */
  sample: (sample: ThroughputSample) => void;
  /** Counted when a transfer finishes, so the session total survives "clear completed". */
  countFinished: (direction: TransferDirection, bytes: number) => void;
  reset: () => void;
}

const EMPTY_TOTALS: TransferTotals = { uploadedBytes: 0, downloadedBytes: 0, completed: 0 };

export const useTransfers = create<TransfersState>()((set) => ({
  transfers: [],
  throughput: [],
  totals: EMPTY_TOTALS,
  add: (transfer) => set((state) => ({ transfers: [...state.transfers, transfer] })),
  update: (id, patch) =>
    set((state) => ({
      transfers: state.transfers.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })),
  remove: (id) => set((state) => ({ transfers: state.transfers.filter((item) => item.id !== id) })),
  clearCompleted: () =>
    set((state) => ({
      transfers: state.transfers.filter(
        (item) => item.status !== 'completed' && item.status !== 'cancelled',
      ),
    })),
  pauseAll: () =>
    set((state) => ({
      transfers: state.transfers.map((item) =>
        item.status === 'running' || item.status === 'queued' ? { ...item, status: 'paused' } : item,
      ),
    })),
  resumeAll: () =>
    set((state) => ({
      transfers: state.transfers.map((item) =>
        item.status === 'paused' ? { ...item, status: 'queued' } : item,
      ),
    })),
  sample: (sample) =>
    set((state) => ({
      throughput: [...state.throughput, sample].slice(-THROUGHPUT_WINDOW),
    })),
  countFinished: (direction, bytes) =>
    set((state) => ({
      totals: {
        uploadedBytes: state.totals.uploadedBytes + (direction === 'upload' ? bytes : 0),
        downloadedBytes: state.totals.downloadedBytes + (direction === 'download' ? bytes : 0),
        completed: state.totals.completed + 1,
      },
    })),
  reset: () => set({ transfers: [], throughput: [], totals: EMPTY_TOTALS }),
}));

export function transferCounts(transfers: readonly Transfer[]): TransferCounts {
  let uploading = 0;
  let downloading = 0;
  let queued = 0;
  let failed = 0;
  let completed = 0;
  for (const transfer of transfers) {
    if (transfer.status === 'failed') failed += 1;
    if (transfer.status === 'completed') completed += 1;
    if (transfer.status === 'queued') queued += 1;
    if (!ACTIVE_STATUSES.includes(transfer.status)) continue;
    if (transfer.direction === 'upload') uploading += 1;
    else downloading += 1;
  }
  return { uploading, downloading, active: uploading + downloading, queued, failed, completed };
}

export function isActive(transfer: Transfer): boolean {
  return ACTIVE_STATUSES.includes(transfer.status);
}

export function transferRatio(transfer: Transfer): number | null {
  if (transfer.totalBytes <= 0) return null;
  return Math.min(1, transfer.transferredBytes / transfer.totalBytes);
}

/** Current throughput per direction, summed over whatever is running right now. */
export function currentSpeed(transfers: readonly Transfer[]): {
  readonly up: number;
  readonly down: number;
} {
  let up = 0;
  let down = 0;
  for (const transfer of transfers) {
    if (transfer.status !== 'running') continue;
    if (transfer.direction === 'upload') up += transfer.bytesPerSecond;
    else down += transfer.bytesPerSecond;
  }
  return { up, down };
}

/** Active transfers first, newest first within each group. */
export function sortedTransfers(transfers: readonly Transfer[]): readonly Transfer[] {
  const activeRank = (transfer: Transfer) => (ACTIVE_STATUSES.includes(transfer.status) ? 0 : 1);
  return [...transfers].sort((left, right) => {
    const byActive = activeRank(left) - activeRank(right);
    if (byActive !== 0) return byActive;
    return right.startedAt.localeCompare(left.startedAt);
  });
}
