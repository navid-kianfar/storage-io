import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * The buckets this browser opened recently, newest first.
 *
 * It is per-browser rather than per-installation: which bucket an operator keeps
 * coming back to is a habit, not a setting, and the API has nowhere to put it. Its
 * own storage key, not `sio.prefs`, because that store's shape is mirrored by the
 * pre-paint script in index.html.
 */
export const RECENT_BUCKETS_STORAGE_KEY = 'sio.recent-buckets';

/** Enough to be useful on the picker; more is a list nobody reads. */
export const RECENT_BUCKETS_LIMIT = 8;

export interface RecentBucket {
  /** The bucket's opaque id — what the browse route is addressed by. */
  readonly bucketId: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly bucket: string;
  readonly at: string;
}

interface RecentBucketsState {
  readonly items: readonly RecentBucket[];
  /** Records a visit, moving an already-known bucket back to the front. */
  visit: (visited: Omit<RecentBucket, 'at'>) => void;
  forget: (serverId: string, bucket: string) => void;
  clear: () => void;
}

function sameBucket(left: { serverId: string; bucket: string }, serverId: string, bucket: string) {
  return left.serverId === serverId && left.bucket === bucket;
}

export const useRecentBuckets = create<RecentBucketsState>()(
  persist(
    (set) => ({
      items: [],
      visit: (visited) =>
        set((state) => {
          const withoutIt = state.items.filter(
            (item) => !sameBucket(item, visited.serverId, visited.bucket),
          );
          const entry: RecentBucket = { ...visited, at: new Date().toISOString() };
          return { items: [entry, ...withoutIt].slice(0, RECENT_BUCKETS_LIMIT) };
        }),
      forget: (serverId, bucket) =>
        set((state) => ({
          items: state.items.filter((item) => !sameBucket(item, serverId, bucket)),
        })),
      clear: () => set({ items: [] }),
    }),
    { name: RECENT_BUCKETS_STORAGE_KEY, partialize: ({ items }) => ({ items }) },
  ),
);
