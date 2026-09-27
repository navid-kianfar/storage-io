import { create } from 'zustand';

/**
 * The browser-side transfer queue.
 *
 * Uploads and downloads run in this tab (XHR, for upload progress), so their
 * state cannot live in TanStack Query — it is not server state. This store is the
 * single source for the topbar's transfers popover and the /transfers page, and
 * the object browser pushes into it.
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
  readonly name: string;
  readonly serverId: string;
  readonly bucket: string;
  readonly key: string;
  readonly totalBytes: number;
  readonly transferredBytes: number;
  readonly status: TransferStatus;
  readonly bytesPerSecond: number;
  readonly error: string | null;
  readonly startedAt: string;
}

export interface TransferCounts {
  readonly uploading: number;
  readonly downloading: number;
  readonly active: number;
  readonly failed: number;
}

const ACTIVE_STATUSES: readonly TransferStatus[] = ['queued', 'running', 'paused'];

interface TransfersState {
  readonly transfers: readonly Transfer[];
  add: (transfer: Transfer) => void;
  update: (id: string, patch: Partial<Omit<Transfer, 'id'>>) => void;
  remove: (id: string) => void;
  clearCompleted: () => void;
  pauseAll: () => void;
  resumeAll: () => void;
}

export const useTransfers = create<TransfersState>()((set) => ({
  transfers: [],
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
        item.status === 'running' ? { ...item, status: 'paused' } : item,
      ),
    })),
  resumeAll: () =>
    set((state) => ({
      transfers: state.transfers.map((item) =>
        item.status === 'paused' ? { ...item, status: 'running' } : item,
      ),
    })),
}));

export function transferCounts(transfers: readonly Transfer[]): TransferCounts {
  let uploading = 0;
  let downloading = 0;
  let failed = 0;
  for (const transfer of transfers) {
    if (transfer.status === 'failed') failed += 1;
    if (!ACTIVE_STATUSES.includes(transfer.status)) continue;
    if (transfer.direction === 'upload') uploading += 1;
    else downloading += 1;
  }
  return { uploading, downloading, active: uploading + downloading, failed };
}

export function transferRatio(transfer: Transfer): number | null {
  if (transfer.totalBytes <= 0) return null;
  return Math.min(1, transfer.transferredBytes / transfer.totalBytes);
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
