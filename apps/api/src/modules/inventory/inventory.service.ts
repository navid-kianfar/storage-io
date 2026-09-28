import { Injectable, Logger } from '@nestjs/common';
import { ListBucketsCommand } from '@aws-sdk/client-s3';
import type { Bucket, BucketDetail, BucketSummary, PaginationQuery } from '@storage-io/contracts';
import { EventBusService } from '../../events/event-bus.service';
import { ServerRepository } from '../../servers/server.repository';
import type { ServerRow } from '../../db/schema';
import { StorageContextService, type StorageContext } from '../storage/storage-context.service';
import { BucketFactsService, SCAN_PAGE_SIZE } from './bucket-facts.service';
import {
  InventoryRepository,
  type BucketCacheFilters,
  type BucketFacts,
} from './inventory.repository';

/** How long a server's cached inventory is considered fresh. */
export const INVENTORY_TTL_MS = 5 * 60_000;

/**
 * Listing pages one server may spend per pass when it has no usage API. 200 pages
 * is 200 000 objects: enough that a typical on-premise bucket is counted exactly,
 * and bounded enough that one enormous bucket cannot monopolise the refresher.
 */
export const SCAN_PAGE_BUDGET = 200;

/** Attribute reads in flight per server. Five calls per bucket, so keep it small. */
const ATTRIBUTE_CONCURRENCY = 4;

/** Server statuses whose cached rows are kept but not refreshed. */
const UNREACHABLE_STATUSES: readonly string[] = ['offline', 'maintenance'];

/**
 * The bucket inventory: what exists on every server, how big it is, and how that
 * changed day by day.
 *
 * Why a cache at all: `GET /buckets` spans every server, and answering it live
 * would mean a `ListBuckets` plus five configuration calls per bucket per page
 * load, with the slowest server setting the latency for all of them. The cache
 * makes that one local query, and an offline server still shows what it had —
 * flagged `unavailable` rather than silently missing.
 *
 * How sizes are obtained, in order of preference:
 *
 * 1. **A native usage API** — MinIO's `datausageinfo` returns every bucket's size
 *    in one call. Ceph and Garage will do the same once their admin drivers exist.
 * 2. **A throttled listing scan**, with a per-server page budget per pass and a
 *    round-robin cursor, so every bucket is eventually counted and no single pass
 *    runs away. A bucket larger than the budget keeps `sizeBytes: null` — the
 *    contract's "unknown" — rather than a number that is wrong.
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);
  /** Where the round-robin scan resumes, per server. Process-local by design. */
  private readonly scanCursor = new Map<string, string>();
  private readonly refreshedAt = new Map<string, number>();

  constructor(
    private readonly repository: InventoryRepository,
    private readonly facts: BucketFactsService,
    private readonly storage: StorageContextService,
    private readonly servers: ServerRepository,
    private readonly bus: EventBusService,
  ) {}

  /* ------------------------------ reading -------------------------- */

  list(filters: BucketCacheFilters, page: PaginationQuery): readonly Bucket[] {
    return this.repository.list(filters, page);
  }

  count(filters: BucketCacheFilters): number {
    return this.repository.count(filters);
  }

  summary(filters: BucketCacheFilters): BucketSummary {
    return this.repository.summary(filters);
  }

  iterateForExport(filters: BucketCacheFilters): Generator<Bucket> {
    return this.repository.iterateForExport(filters);
  }

  cached(serverId: string, bucket: string): Bucket | null {
    return this.repository.findOne(serverId, bucket);
  }

  cachedDetail(serverId: string, bucket: string): BucketDetail | null {
    return this.repository.findOneDetail(serverId, bucket);
  }

  /** What a bucket id names, or `null` when no cached bucket carries it. */
  locate(bucketId: string): { readonly serverId: string; readonly name: string } | null {
    return this.repository.locate(bucketId);
  }

  /** A cached bucket's opaque id, or `null` when it has never been cached. */
  idOf(serverId: string, bucket: string): string | null {
    return this.repository.idOf(serverId, bucket);
  }

  cachedFor(serverId: string): readonly Bucket[] {
    return this.repository.cachedFor(serverId);
  }

  /* ------------------------------ writing -------------------------- */

  /** After a mutation through storage-io, so the list does not lag the action. */
  patch(serverId: string, bucket: string, facts: Omit<BucketFacts, 'name'>): void {
    this.repository.patch(serverId, bucket, facts);
  }

  forget(serverId: string, bucket: string): void {
    this.repository.remove(serverId, bucket);
    this.servers.update(serverId, { bucketCount: this.repository.namesFor(serverId).length });
  }

  /**
   * Reads one bucket's attributes now and stores them — used right after create.
   *
   * `createdAt` is stamped when the caller says the bucket has just been made:
   * `CreateBucket` returns no timestamp, and reading one back would mean a whole
   * `ListBuckets` for a value we already know.
   */
  async refreshBucket(
    context: StorageContext,
    bucket: string,
    options: { readonly justCreated?: boolean } = {},
  ): Promise<void> {
    const attributes = await this.facts.readAttributes(context.client, bucket);
    this.repository.upsert(context.row.id, [
      {
        name: bucket,
        versioning: attributes.versioning,
        objectLock: attributes.objectLock,
        access: attributes.access,
        tags: attributes.tags,
        region: attributes.region,
        ...(options.justCreated === true ? { createdAt: nowIso() } : {}),
      },
    ]);
  }

  /* ---------------------------- refreshing ------------------------- */

  isDue(row: ServerRow, now = Date.now()): boolean {
    if (UNREACHABLE_STATUSES.includes(row.status)) return false;
    const last = this.refreshedAt.get(row.id);
    return last === undefined || now - last >= INVENTORY_TTL_MS;
  }

  /**
   * One pass over one server. Never throws: the refresher is a background sweep
   * and a server that failed keeps the rows it had, which is the whole point of
   * the cache. The count of buckets is returned, or `null` when the pass failed.
   */
  async refreshServer(row: ServerRow): Promise<number | null> {
    this.refreshedAt.set(row.id, Date.now());

    try {
      const context = this.storage.fromRow(row);
      const listed = await this.listBuckets(context);
      this.repository.removeMissing(
        row.id,
        listed.map((entry) => entry.name),
      );

      const usage = await this.nativeUsage(context);
      const attributes = await this.readAllAttributes(context, listed);
      const scanned = await this.scanMissing(context, listed, usage);

      const facts = listed.map((entry): BucketFacts => {
        const native = usage.get(entry.name);
        const scan = scanned.get(entry.name);
        return {
          name: entry.name,
          createdAt: entry.createdAt,
          owner: entry.owner,
          ...(attributes.get(entry.name) ?? {}),
          ...sizeFactsOf(native, scan),
        };
      });

      this.repository.upsert(row.id, facts);
      this.recordSamples(row.id, facts);
      this.servers.update(row.id, { bucketCount: facts.length });

      this.bus.publish('inventory.updated', {
        serverId: row.id,
        buckets: facts.length,
        at: new Date().toISOString(),
      });

      return facts.length;
    } catch (error) {
      this.logger.warn(
        { server: row.name, err: error instanceof Error ? error.message : String(error) },
        'Inventory refresh failed; the cached rows are kept',
      );
      return null;
    }
  }

  /* ------------------------------ private -------------------------- */

  private async listBuckets(
    context: StorageContext,
  ): Promise<readonly { name: string; createdAt: string | null; owner: string | null }[]> {
    const response = await context.client.send(new ListBucketsCommand({}));
    const owner = response.Owner?.DisplayName ?? response.Owner?.ID ?? null;

    return (response.Buckets ?? [])
      .filter((bucket) => typeof bucket.Name === 'string')
      .map((bucket) => ({
        name: bucket.Name as string,
        createdAt: bucket.CreationDate?.toISOString() ?? null,
        owner,
      }));
  }

  /** Per-bucket sizes in one call, when the driver has a usage sub-driver. */
  private async nativeUsage(
    context: StorageContext,
  ): Promise<ReadonlyMap<string, { sizeBytes: number | null; objects: number | null }>> {
    const result = new Map<string, { sizeBytes: number | null; objects: number | null }>();
    if (context.driver.usage === undefined) return result;

    try {
      const usage = await context.driver.usage.getUsage(context.connection);
      for (const bucket of usage.buckets) {
        result.set(bucket.name, { sizeBytes: bucket.sizeBytes, objects: bucket.objects });
      }
    } catch (error) {
      // The usage API being unavailable is not a failed pass: the scan path
      // below covers it, more slowly.
      this.logger.debug(
        { server: context.row.name, err: error instanceof Error ? error.message : String(error) },
        'Native usage unavailable; falling back to a listing scan',
      );
    }
    return result;
  }

  private async readAllAttributes(
    context: StorageContext,
    listed: readonly { name: string }[],
  ): Promise<ReadonlyMap<string, Partial<BucketFacts>>> {
    const result = new Map<string, Partial<BucketFacts>>();

    await mapWithConcurrency(listed, ATTRIBUTE_CONCURRENCY, async (entry) => {
      const attributes = await this.facts.readAttributes(context.client, entry.name);
      result.set(entry.name, {
        versioning: attributes.versioning,
        objectLock: attributes.objectLock,
        access: attributes.access,
        tags: attributes.tags,
        region: attributes.region,
      });
    });

    return result;
  }

  /**
   * Scans the buckets the usage API did not cover, spending at most
   * `SCAN_PAGE_BUDGET` pages and resuming where the last pass stopped.
   */
  private async scanMissing(
    context: StorageContext,
    listed: readonly { name: string }[],
    usage: ReadonlyMap<string, unknown>,
  ): Promise<
    ReadonlyMap<
      string,
      { sizeBytes: number | null; objects: number | null; lastWriteAt: string | null }
    >
  > {
    const result = new Map<
      string,
      { sizeBytes: number | null; objects: number | null; lastWriteAt: string | null }
    >();

    const pending = listed.filter((entry) => !usage.has(entry.name)).map((entry) => entry.name);
    if (pending.length === 0) {
      this.scanCursor.delete(context.row.id);
      return result;
    }

    let budget = SCAN_PAGE_BUDGET;
    for (const bucket of rotateFrom(pending, this.scanCursor.get(context.row.id))) {
      if (budget <= 0) {
        // Where the next pass picks up, so a long tail of buckets is not starved
        // by whichever one happens to sort first.
        this.scanCursor.set(context.row.id, bucket);
        break;
      }

      const scan = await this.facts.scan(context.client, bucket, budget);
      budget -= scan.pagesUsed;

      if (scan.truncated) {
        this.logger.warn(
          { server: context.row.name, bucket, pages: scan.pagesUsed, pageSize: SCAN_PAGE_SIZE },
          'Bucket is larger than the inventory scan budget; its size is reported as unknown',
        );
        result.set(bucket, { sizeBytes: null, objects: null, lastWriteAt: scan.lastWriteAt });
        this.scanCursor.set(context.row.id, bucket);
        break;
      }

      result.set(bucket, {
        sizeBytes: scan.sizeBytes,
        objects: scan.objects,
        lastWriteAt: scan.lastWriteAt,
      });
    }

    return result;
  }

  private recordSamples(serverId: string, facts: readonly BucketFacts[]): void {
    const samples = facts
      .filter((fact) => typeof fact.sizeBytes === 'number')
      .map((fact) => ({
        bucket: fact.name,
        sizeBytes: fact.sizeBytes as number,
        objects: fact.objects ?? null,
      }));
    this.repository.recordDailySizes(serverId, samples);
  }
}

/* ------------------------------ helpers --------------------------- */

interface SizeFacts {
  readonly sizeBytes?: number | null;
  readonly objects?: number | null;
  readonly statsAt?: string | null;
  readonly lastWriteAt?: string | null;
}

/**
 * `undefined` for a bucket neither source covered this pass, so the upsert leaves
 * its previous numbers alone instead of blanking them.
 */
function sizeFactsOf(
  native: { sizeBytes: number | null; objects: number | null } | undefined,
  scan:
    { sizeBytes: number | null; objects: number | null; lastWriteAt: string | null } | undefined,
): SizeFacts {
  if (native !== undefined) {
    return { sizeBytes: native.sizeBytes, objects: native.objects, statsAt: nowIso() };
  }
  if (scan !== undefined) {
    return {
      sizeBytes: scan.sizeBytes,
      objects: scan.objects,
      statsAt: scan.sizeBytes === null ? null : nowIso(),
      lastWriteAt: scan.lastWriteAt,
    };
  }
  return {};
}

const nowIso = (): string => new Date().toISOString();

/**
 * The list rotated so it starts at `from`, which is how the scan resumes without
 * remembering an index into a list that may have changed length.
 */
export function rotateFrom(names: readonly string[], from: string | undefined): readonly string[] {
  if (from === undefined) return names;
  const index = names.indexOf(from);
  if (index <= 0) return names;
  return [...names.slice(index), ...names.slice(0, index)];
}

/**
 * Runs `work` over `items` with at most `limit` in flight. `Promise.all` over
 * every bucket at once would open a connection per bucket and make the server's
 * own contention the thing being measured.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await work(item);
    }
  });
  await Promise.all(workers);
}
