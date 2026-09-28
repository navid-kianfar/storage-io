import { Injectable } from '@nestjs/common';
import {
  QUOTA_TREND_DAYS,
  type Bucket,
  type ListQuotasQuery,
  type PaginationQuery,
  type QuotaList,
  type QuotaRow,
  type QuotaSupport,
} from '@storage-io/contracts';
import { NotFoundError } from '../../common/errors/domain.exception';
import { ServerRepository } from '../../servers/server.repository';
import {
  InventoryRepository,
  trendKey,
  type BucketCacheFilters,
} from '../inventory/inventory.repository';

/**
 * The quotas page: one row per bucket with its usage ratio, a seven-day trend and
 * how the limit is actually enforced.
 *
 * Everything is read from the inventory cache and the quota table — no storage
 * server is contacted. That is what makes the page answer in one query across every
 * server, and it is why a row for an offline server reports `unavailable` rather
 * than pretending the number is current.
 */
@Injectable()
export class QuotasService {
  constructor(
    private readonly inventory: InventoryRepository,
    private readonly servers: ServerRepository,
  ) {}

  list(query: ListQuotasQuery, page: PaginationQuery): QuotaList {
    const filters = this.filtersOf(query);
    const buckets = this.inventory.list(filters, page);

    return {
      items: this.toRows(buckets),
      total: this.inventory.count(filters),
      summary: this.inventory.quotaSummary(filters),
    };
  }

  /** The same filtered set, streamed for the CSV export. */
  *iterateForExport(query: ListQuotasQuery): Generator<QuotaRow> {
    const filters = this.filtersOf(query);
    // Batched by the repository's generator; each batch gets its trends in one
    // query rather than one per row.
    let batch: Bucket[] = [];
    for (const bucket of this.inventory.iterateForExport(filters)) {
      batch.push(bucket);
      if (batch.length < EXPORT_BATCH) continue;
      yield* this.toRows(batch);
      batch = [];
    }
    if (batch.length > 0) yield* this.toRows(batch);
  }

  /* ------------------------------ internals ------------------------ */

  /**
   * Trends for the whole page in one query. A sparkline per row looks like a good
   * reason for a query per row, and it is the classic N+1.
   */
  private toRows(buckets: readonly Bucket[]): QuotaRow[] {
    const trends = this.inventory.trends(
      buckets.map((bucket) => ({ serverId: bucket.serverId, bucket: bucket.name })),
      QUOTA_TREND_DAYS,
    );

    return buckets.map((bucket): QuotaRow => {
      const series = trends.get(trendKey(bucket.serverId, bucket.name)) ?? [];
      return {
        bucket,
        usageRatio: usageRatioOf(bucket),
        trend: [...series],
        supported: supportOf(bucket),
      };
    });
  }

  private filtersOf(query: ListQuotasQuery): BucketCacheFilters {
    const resolved =
      query.serverId === undefined ? undefined : this.servers.findByIdOrName(query.serverId);
    if (query.serverId !== undefined && resolved === null) {
      throw new NotFoundError(`No server named "${query.serverId}".`);
    }

    return {
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(resolved === undefined || resolved === null ? {} : { serverId: resolved.id }),
      quota: query.filter,
      // Fullest first: the rows that need attention are the ones at the top.
      sort: 'quota',
    };
  }
}

/* ------------------------------ helpers --------------------------- */

const EXPORT_BATCH = 200;

/** `null` when there is no quota, or when the size is not known. */
export function usageRatioOf(bucket: Bucket): number | null {
  if (bucket.quota === null || bucket.quota.limitBytes === 0) return null;
  if (bucket.sizeBytes === null) return null;
  return bucket.sizeBytes / bucket.quota.limitBytes;
}

/**
 * What the limit actually does. `unavailable` is about the *numbers*, not the
 * limit: an offline server's usage is a cached figure, so a ratio computed from it
 * must be presented as stale rather than as a fact.
 */
export function supportOf(bucket: Bucket): QuotaSupport {
  if (bucket.unavailable) return 'unavailable';
  if (bucket.quota === null) return 'alert-only';
  return bucket.quota.native ? 'native' : 'alert-only';
}
