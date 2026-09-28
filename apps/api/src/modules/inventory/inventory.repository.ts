import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  like,
  lt,
  notInArray,
  or,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import {
  QUOTA_THRESHOLD_DEFAULT,
  type Bucket,
  type BucketAccess,
  type BucketDetail,
  type BucketSort,
  type BucketSummary,
  type BucketVersioning,
  type PaginationQuery,
  type Provider,
  type Quota,
  type QuotaFilter,
  type QuotaMode,
} from '@storage-io/contracts';
import { DB } from '../../db/db.module';
import type { AppDatabase } from '../../db/migrate';
import { bucketCache, bucketSizeDaily, quotas, servers } from '../../db/schema';
import { escapeLike } from '../../activity/activity.service';

/** A quota threshold is stored in permille so the column stays an integer. */
const PERMILLE = 1000;

/** Statuses whose cached numbers are stale by definition. */
const OFFLINE_STATUSES: readonly string[] = ['offline', 'unknown'];

export interface BucketCacheFilters {
  readonly q?: string;
  /** Already resolved to a server id by the caller. */
  readonly serverId?: string;
  readonly access?: BucketAccess;
  readonly sort?: BucketSort;
  /**
   * The quotas page's own filter. Pushed into SQL rather than applied after the
   * fact, so paging stays the database's job: filtering a page in memory gives the
   * caller a short page and a wrong total.
   */
  readonly quota?: QuotaFilter;
}

/** What the refresher discovered about one bucket; `undefined` means "unchanged". */
export interface BucketFacts {
  readonly name: string;
  readonly region?: string | null;
  readonly createdAt?: string | null;
  readonly objects?: number | null;
  readonly sizeBytes?: number | null;
  readonly statsAt?: string | null;
  readonly versioning?: BucketVersioning;
  readonly objectLock?: boolean;
  readonly access?: BucketAccess;
  readonly owner?: string | null;
  readonly tags?: Readonly<Record<string, string>>;
  readonly defaultStorageClass?: string | null;
  readonly noncurrentVersions?: number | null;
  readonly lastWriteAt?: string | null;
}

/**
 * Every query over the bucket inventory: the cache the refresher writes and the
 * aggregated list the UI reads.
 *
 * Filtering, sorting, paging and the summary all happen in SQLite. The
 * alternative — loading every bucket on every server and reducing in JavaScript
 * — is fast with three buckets and an outage with thirty thousand.
 */
@Injectable()
export class InventoryRepository {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  /* ---------------------------- reading ---------------------------- */

  /** One page of the aggregated list, ordered in SQL. */
  list(filters: BucketCacheFilters, page: PaginationQuery): readonly Bucket[] {
    const rows = this.selectJoined()
      .where(this.whereFor(filters))
      .orderBy(...this.orderFor(filters.sort ?? 'size'))
      .limit(page.pageSize)
      .offset((page.page - 1) * page.pageSize)
      .all();

    return rows.map(toBucket);
  }

  count(filters: BucketCacheFilters): number {
    const [row] = this.db
      .select({ total: count() })
      .from(bucketCache)
      .innerJoin(servers, eq(servers.id, bucketCache.serverId))
      .leftJoin(quotaJoin(), quotaOn())
      .where(this.whereFor(filters))
      .all();
    return row?.total ?? 0;
  }

  /**
   * The header figures, aggregated in one statement over the *filtered* set —
   * they describe what the operator is looking at, not the whole installation.
   */
  summary(filters: BucketCacheFilters): BucketSummary {
    const [row] = this.db
      .select({
        buckets: count(),
        sizeBytes: sum(bucketCache.sizeBytes).mapWith(Number),
        objects: sum(bucketCache.objects).mapWith(Number),
        withQuota: sql<number>`sum(case when ${quotas.limitBytes} is null then 0 else 1 end)`,
        nearQuota: sql<number>`sum(case
          when ${quotas.limitBytes} is null or ${quotas.limitBytes} = 0 then 0
          when cast(coalesce(${bucketCache.sizeBytes}, 0) as real) / ${quotas.limitBytes}
               >= cast(${quotas.threshold} as real) / ${PERMILLE} then 1
          else 0 end)`,
        public: sql<number>`sum(case when ${bucketCache.access} = 'private' then 0 else 1 end)`,
      })
      .from(bucketCache)
      .innerJoin(servers, eq(servers.id, bucketCache.serverId))
      .leftJoin(quotaJoin(), quotaOn())
      .where(this.whereFor(filters))
      .all();

    return {
      buckets: row?.buckets ?? 0,
      sizeBytes: row?.sizeBytes ?? 0,
      objects: row?.objects ?? 0,
      withQuota: row?.withQuota ?? 0,
      nearQuota: row?.nearQuota ?? 0,
      public: row?.public ?? 0,
    };
  }

  /** The quotas page's header figures, over the same filtered set. */
  quotaSummary(filters: BucketCacheFilters): QuotaSummary {
    const ratio = usageRatioSql();
    const [row] = this.db
      .select({
        withQuota: sql<number>`sum(case when ${quotas.limitBytes} is null then 0 else 1 end)`,
        over90: sql<number>`sum(case when ${ratio} >= 0.9 then 1 else 0 end)`,
        over80: sql<number>`sum(case when ${ratio} >= 0.8 then 1 else 0 end)`,
        unlimited: sql<number>`sum(case when ${quotas.limitBytes} is null then 1 else 0 end)`,
      })
      .from(bucketCache)
      .innerJoin(servers, eq(servers.id, bucketCache.serverId))
      .leftJoin(quotaJoin(), quotaOn())
      .where(this.whereFor(filters))
      .all();

    return {
      withQuota: row?.withQuota ?? 0,
      over90: row?.over90 ?? 0,
      over80: row?.over80 ?? 0,
      unlimited: row?.unlimited ?? 0,
    };
  }

  /**
   * The whole filtered set, in pages, for the CSV export. A generator rather than
   * an array: an export must not depend on every row fitting in memory at once.
   */
  *iterateForExport(filters: BucketCacheFilters, batchSize = 500): Generator<Bucket> {
    let offset = 0;
    for (;;) {
      const rows = this.selectJoined()
        .where(this.whereFor(filters))
        .orderBy(...this.orderFor(filters.sort ?? 'size'))
        .limit(batchSize)
        .offset(offset)
        .all();

      if (rows.length === 0) return;
      for (const row of rows) yield toBucket(row);
      if (rows.length < batchSize) return;
      offset += batchSize;
    }
  }

  findOne(serverId: string, bucket: string): Bucket | null {
    const [row] = this.selectJoined()
      .where(and(eq(bucketCache.serverId, serverId), eq(bucketCache.name, bucket)))
      .limit(1)
      .all();
    return row === undefined ? null : toBucket(row);
  }

  findOneDetail(serverId: string, bucket: string): BucketDetail | null {
    const [row] = this.selectJoined()
      .where(and(eq(bucketCache.serverId, serverId), eq(bucketCache.name, bucket)))
      .limit(1)
      .all();
    if (row === undefined) return null;
    return {
      ...toBucket(row),
      owner: row.owner,
      tags: row.tags,
      defaultStorageClass: row.defaultStorageClass,
      noncurrentVersions: row.noncurrentVersions,
    };
  }

  /** Bucket names the cache holds for a server, to find the ones that vanished. */
  namesFor(serverId: string): readonly string[] {
    return this.db
      .select({ name: bucketCache.name })
      .from(bucketCache)
      .where(eq(bucketCache.serverId, serverId))
      .all()
      .map((row) => row.name);
  }

  /** Every bucket a server has, with its usage — what the quota watcher walks. */
  cachedFor(serverId: string): readonly Bucket[] {
    const rows = this.selectJoined().where(eq(bucketCache.serverId, serverId)).all();
    return rows.map(toBucket);
  }

  /* ---------------------------- writing ---------------------------- */

  /**
   * Upserts what the refresher learned, in one transaction. Only the fields the
   * caller actually observed are written: a pass that read sizes but not tags
   * must not blank the tags it did not look at.
   */
  upsert(serverId: string, facts: readonly BucketFacts[]): void {
    if (facts.length === 0) return;
    const updatedAt = new Date().toISOString();

    this.db.transaction((tx) => {
      for (const fact of facts) {
        const values = {
          serverId,
          name: fact.name,
          region: fact.region ?? null,
          createdAt: fact.createdAt ?? null,
          objects: fact.objects ?? null,
          sizeBytes: fact.sizeBytes ?? null,
          statsAt: fact.statsAt ?? null,
          versioning: fact.versioning ?? 'off',
          objectLock: fact.objectLock ?? false,
          access: fact.access ?? 'private',
          owner: fact.owner ?? null,
          tags: fact.tags === undefined ? {} : { ...fact.tags },
          defaultStorageClass: fact.defaultStorageClass ?? null,
          noncurrentVersions: fact.noncurrentVersions ?? null,
          lastWriteAt: fact.lastWriteAt ?? null,
          updatedAt,
        };

        tx.insert(bucketCache)
          .values(values)
          .onConflictDoUpdate({
            target: [bucketCache.serverId, bucketCache.name],
            set: { ...definedOnly(fact), updatedAt },
          })
          .run();
      }
    });
  }

  /** One bucket, after a mutation went through storage-io. */
  patch(serverId: string, bucket: string, facts: Omit<BucketFacts, 'name'>): void {
    const set = definedOnly({ name: bucket, ...facts });
    if (Object.keys(set).length === 0) return;
    this.db
      .update(bucketCache)
      .set({ ...set, updatedAt: new Date().toISOString() })
      .where(and(eq(bucketCache.serverId, serverId), eq(bucketCache.name, bucket)))
      .run();
  }

  remove(serverId: string, bucket: string): void {
    this.db.transaction((tx) => {
      tx.delete(bucketCache)
        .where(and(eq(bucketCache.serverId, serverId), eq(bucketCache.name, bucket)))
        .run();
      tx.delete(bucketSizeDaily)
        .where(and(eq(bucketSizeDaily.serverId, serverId), eq(bucketSizeDaily.bucket, bucket)))
        .run();
    });
  }

  /** Buckets the server no longer has — one set-based delete, never a loop. */
  removeMissing(serverId: string, keep: readonly string[]): number {
    const condition =
      keep.length === 0
        ? eq(bucketCache.serverId, serverId)
        : and(eq(bucketCache.serverId, serverId), notInArray(bucketCache.name, [...keep]));

    const result = this.db.delete(bucketCache).where(condition).run();
    return result.changes;
  }

  /* -------------------------- daily samples ------------------------ */

  /** One sample per bucket per UTC day; a second call the same day replaces it. */
  recordDailySizes(
    serverId: string,
    samples: readonly { bucket: string; sizeBytes: number; objects: number | null }[],
  ): void {
    if (samples.length === 0) return;
    const at = new Date().toISOString();
    const day = at.slice(0, 10);

    this.db.transaction((tx) => {
      for (const sample of samples) {
        tx.insert(bucketSizeDaily)
          .values({
            serverId,
            bucket: sample.bucket,
            day,
            sizeBytes: sample.sizeBytes,
            objects: sample.objects,
            at,
          })
          .onConflictDoUpdate({
            target: [bucketSizeDaily.serverId, bucketSizeDaily.bucket, bucketSizeDaily.day],
            set: { sizeBytes: sample.sizeBytes, objects: sample.objects, at },
          })
          .run();
      }
    });
  }

  /**
   * The last `days` samples for the given buckets, in one query — the trend
   * sparkline is drawn for a whole page of quotas, and a query per row would be
   * the N+1 this avoids.
   */
  trends(
    refs: readonly { serverId: string; bucket: string }[],
    days: number,
  ): ReadonlyMap<string, readonly number[]> {
    const result = new Map<string, number[]>();
    if (refs.length === 0) return result;

    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const serverIds = [...new Set(refs.map((ref) => ref.serverId))];
    const names = [...new Set(refs.map((ref) => ref.bucket))];

    const rows = this.db
      .select({
        serverId: bucketSizeDaily.serverId,
        bucket: bucketSizeDaily.bucket,
        day: bucketSizeDaily.day,
        sizeBytes: bucketSizeDaily.sizeBytes,
      })
      .from(bucketSizeDaily)
      .where(
        and(
          inArray(bucketSizeDaily.serverId, serverIds),
          inArray(bucketSizeDaily.bucket, names),
          gte(bucketSizeDaily.day, since),
        ),
      )
      .orderBy(asc(bucketSizeDaily.day))
      .all();

    for (const row of rows) {
      const key = trendKey(row.serverId, row.bucket);
      const series = result.get(key);
      if (series === undefined) result.set(key, [row.sizeBytes]);
      else series.push(row.sizeBytes);
    }
    return result;
  }

  /**
   * Installation-wide daily totals, for the dashboard growth chart. Kept here
   * because this table is written here; wave 2c's dashboard reads it.
   */
  dailyTotals(days: number): readonly { day: string; usedBytes: number }[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return this.db
      .select({
        day: bucketSizeDaily.day,
        usedBytes: sum(bucketSizeDaily.sizeBytes).mapWith(Number),
      })
      .from(bucketSizeDaily)
      .where(gte(bucketSizeDaily.day, since))
      .groupBy(bucketSizeDaily.day)
      .orderBy(asc(bucketSizeDaily.day))
      .all()
      .map((row) => ({ day: row.day, usedBytes: row.usedBytes ?? 0 }));
  }

  /**
   * The same series for object counts, which the dashboard's "objects added today"
   * figure is the difference of. Separate from `dailyTotals` because a null
   * `objects` sample must not be counted as zero, and mixing the two into one query
   * would make either the bytes or the objects wrong on a bucket whose count is
   * unknown.
   */
  dailyObjectTotals(days: number): readonly { day: string; objects: number }[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return this.db
      .select({
        day: bucketSizeDaily.day,
        objects: sum(bucketSizeDaily.objects).mapWith(Number),
      })
      .from(bucketSizeDaily)
      .where(and(gte(bucketSizeDaily.day, since), sql`${bucketSizeDaily.objects} is not null`))
      .groupBy(bucketSizeDaily.day)
      .orderBy(asc(bucketSizeDaily.day))
      .all()
      .map((row) => ({ day: row.day, objects: row.objects ?? 0 }));
  }

  /** Retention sweep for the samples, on the same budget as the other metrics. */
  deleteSamplesOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return this.db.delete(bucketSizeDaily).where(lt(bucketSizeDaily.day, cutoff)).run().changes;
  }

  /* ------------------------------ private -------------------------- */

  private selectJoined() {
    return this.db
      .select({
        serverId: bucketCache.serverId,
        serverName: servers.name,
        provider: servers.provider,
        serverStatus: servers.status,
        name: bucketCache.name,
        region: bucketCache.region,
        createdAt: bucketCache.createdAt,
        objects: bucketCache.objects,
        sizeBytes: bucketCache.sizeBytes,
        statsAt: bucketCache.statsAt,
        versioning: bucketCache.versioning,
        objectLock: bucketCache.objectLock,
        access: bucketCache.access,
        owner: bucketCache.owner,
        tags: bucketCache.tags,
        defaultStorageClass: bucketCache.defaultStorageClass,
        noncurrentVersions: bucketCache.noncurrentVersions,
        lastWriteAt: bucketCache.lastWriteAt,
        quotaLimitBytes: quotas.limitBytes,
        quotaMode: quotas.mode,
        quotaThreshold: quotas.threshold,
        quotaNative: quotas.native,
      })
      .from(bucketCache)
      .innerJoin(servers, eq(servers.id, bucketCache.serverId))
      .leftJoin(quotaJoin(), quotaOn());
  }

  private whereFor(filters: BucketCacheFilters): SQL | undefined {
    const conditions: SQL[] = [];
    if (filters.serverId !== undefined) conditions.push(eq(bucketCache.serverId, filters.serverId));
    if (filters.access !== undefined) conditions.push(eq(bucketCache.access, filters.access));

    if (filters.q !== undefined && filters.q.length > 0) {
      const needle = `%${escapeLike(filters.q)}%`;
      const search = or(like(bucketCache.name, needle), like(servers.name, needle));
      if (search !== undefined) conditions.push(search);
    }

    const quota = quotaCondition(filters.quota);
    if (quota !== null) conditions.push(quota);

    if (conditions.length === 0) return undefined;
    return and(...conditions);
  }

  /** The bucket name is always the tie-breaker, so paging is stable. */
  private orderFor(sort: BucketSort): readonly SQL[] {
    const byName = asc(bucketCache.name);
    switch (sort) {
      case 'name':
        return [byName];
      case 'size':
        return [desc(bucketCache.sizeBytes), byName];
      case 'written':
        return [desc(bucketCache.lastWriteAt), byName];
      case 'quota':
        return [desc(usageRatioSql()), byName];
    }
  }
}

/* ------------------------------ helpers --------------------------- */

export interface QuotaSummary {
  readonly withQuota: number;
  readonly over90: number;
  readonly over80: number;
  readonly unlimited: number;
}

/**
 * `near` means "at or past its own alert threshold", which is per quota rather
 * than a fixed percentage — an operator who set 60% on one bucket means it.
 */
function quotaCondition(filter: QuotaFilter | undefined): SQL | null {
  switch (filter) {
    case undefined:
    case 'all':
      return null;
    case 'unlimited':
      return sql`${quotas.limitBytes} is null`;
    case 'near':
      return sql`${quotas.limitBytes} is not null and ${quotas.limitBytes} > 0
        and cast(coalesce(${bucketCache.sizeBytes}, 0) as real) / ${quotas.limitBytes}
            >= cast(${quotas.threshold} as real) / ${PERMILLE}`;
  }
}

export const trendKey = (serverId: string, bucket: string): string => `${serverId}\u0000${bucket}`;

/**
 * `quotas` joined on both key columns. Split into two helpers so the same join
 * reads identically in the list, the count and the summary.
 */
const quotaJoin = () => quotas;
const quotaOn = () =>
  and(eq(quotas.serverId, bucketCache.serverId), eq(quotas.bucket, bucketCache.name));

/** `-1` for "no quota", so a DESC sort puts unlimited buckets last. */
const usageRatioSql = (): SQL<number> => sql<number>`case
  when ${quotas.limitBytes} is null or ${quotas.limitBytes} = 0 then -1
  else cast(coalesce(${bucketCache.sizeBytes}, 0) as real) / ${quotas.limitBytes} end`;

interface JoinedRow {
  readonly serverId: string;
  readonly serverName: string;
  readonly provider: string;
  readonly serverStatus: string;
  readonly name: string;
  readonly region: string | null;
  readonly createdAt: string | null;
  readonly objects: number | null;
  readonly sizeBytes: number | null;
  readonly statsAt: string | null;
  readonly versioning: string;
  readonly objectLock: boolean;
  readonly access: string;
  readonly owner: string | null;
  readonly tags: Record<string, string>;
  readonly defaultStorageClass: string | null;
  readonly noncurrentVersions: number | null;
  readonly lastWriteAt: string | null;
  readonly quotaLimitBytes: number | null;
  readonly quotaMode: string | null;
  readonly quotaThreshold: number | null;
  readonly quotaNative: boolean | null;
}

function toBucket(row: JoinedRow): Bucket {
  return {
    serverId: row.serverId,
    serverName: row.serverName,
    provider: row.provider as Provider,
    name: row.name,
    region: row.region,
    createdAt: row.createdAt,
    objects: row.objects,
    sizeBytes: row.sizeBytes,
    statsAt: row.statsAt,
    versioning: row.versioning as BucketVersioning,
    objectLock: row.objectLock,
    access: row.access as BucketAccess,
    quota: toQuota(row),
    // The numbers are the cache's either way; `unavailable` says the server
    // cannot currently confirm them, which is what the UI badges.
    unavailable: OFFLINE_STATUSES.includes(row.serverStatus),
  };
}

function toQuota(row: JoinedRow): Quota | null {
  if (row.quotaLimitBytes === null) return null;
  return {
    limitBytes: row.quotaLimitBytes,
    mode: (row.quotaMode ?? 'alert') as QuotaMode,
    threshold:
      row.quotaThreshold === null ? QUOTA_THRESHOLD_DEFAULT : row.quotaThreshold / PERMILLE,
    native: row.quotaNative ?? false,
  };
}

/**
 * Only the keys the caller set, so an upsert of partial facts leaves the rest of
 * the row alone. `undefined` means "not observed"; `null` means "observed as
 * absent" and is written.
 */
function definedOnly(facts: BucketFacts): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (facts.region !== undefined) set['region'] = facts.region;
  if (facts.createdAt !== undefined) set['createdAt'] = facts.createdAt;
  if (facts.objects !== undefined) set['objects'] = facts.objects;
  if (facts.sizeBytes !== undefined) set['sizeBytes'] = facts.sizeBytes;
  if (facts.statsAt !== undefined) set['statsAt'] = facts.statsAt;
  if (facts.versioning !== undefined) set['versioning'] = facts.versioning;
  if (facts.objectLock !== undefined) set['objectLock'] = facts.objectLock;
  if (facts.access !== undefined) set['access'] = facts.access;
  if (facts.owner !== undefined) set['owner'] = facts.owner;
  if (facts.tags !== undefined) set['tags'] = { ...facts.tags };
  if (facts.defaultStorageClass !== undefined) {
    set['defaultStorageClass'] = facts.defaultStorageClass;
  }
  if (facts.noncurrentVersions !== undefined) set['noncurrentVersions'] = facts.noncurrentVersions;
  if (facts.lastWriteAt !== undefined) set['lastWriteAt'] = facts.lastWriteAt;
  return set;
}
