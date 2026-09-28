import { Injectable } from '@nestjs/common';
import {
  DASHBOARD_ACTIVITY_COUNT,
  DASHBOARD_EXPIRING_KEY_DAYS,
  DASHBOARD_GROWTH_DAYS,
  DASHBOARD_JOB_COUNT,
  DASHBOARD_LARGEST_BUCKET_COUNT,
  type AccessKey,
  type Dashboard,
  type DashboardTotals,
  type Provider,
  type ServerStatus,
} from '@storage-io/contracts';
import { ActivityService } from '../../activity/activity.service';
import { ServerRepository } from '../../servers/server.repository';
import { InventoryRepository } from '../inventory/inventory.repository';
import { IamStatsService } from '../iam-core/iam-stats.service';
import { IamEntityRepository, requireId } from '../iam-core/iam-entity.repository';
import { KeyMetaRepository } from '../iam-core/key-meta.repository';
import { toAccessKey } from '../iam-core/access-key.mapper';
import { JobsRepository } from '../jobs/jobs.repository';
import type { KeyMetaRow, ServerRow } from '../../db/schema';

/**
 * `GET /dashboard`: one request that answers the whole landing page.
 *
 * **Nothing here talks to a storage server.** Every figure comes from a local
 * table — the bucket cache, the daily size samples, the metrics tables, the
 * activity trail, `key_meta`, the jobs table and `IamStatsService`'s snapshot.
 * That is the point: a dashboard that fanned out to every server would take as
 * long as the slowest one, and would show an operator nothing at all during the
 * outage they opened it to look at.
 *
 * The cost of that is staleness, bounded by the inventory refresher's interval and
 * the IAM count sweep's. Where a number has an age worth knowing, the contract
 * carries it (`Bucket.statsAt`), and where it does not, an aggregate a few minutes
 * old is the right answer for a headline.
 */

/** A day in milliseconds, for the two deltas. */
const DAY_MS = 86_400_000;
const GROWTH_DELTA_DAYS = 7;

@Injectable()
export class DashboardService {
  constructor(
    private readonly servers: ServerRepository,
    private readonly inventory: InventoryRepository,
    private readonly activity: ActivityService,
    private readonly jobs: JobsRepository,
    private readonly iamStats: IamStatsService,
    private readonly keyMeta: KeyMetaRepository,
    private readonly entities: IamEntityRepository,
  ) {}

  async get(): Promise<Dashboard> {
    const serverRows = this.servers.findAll();
    const growth = this.growth();

    return {
      totals: await this.totals(serverRows, growth),
      growth: [...growth],
      byServer: serverRows.map((row) => ({
        serverId: row.id,
        name: row.name,
        provider: row.provider as Provider,
        usedBytes: row.capacityUsedBytes ?? 0,
        totalBytes: row.capacityTotalBytes,
      })),
      jobs: this.jobs.active(DASHBOARD_JOB_COUNT).map((row) => this.jobs.toContract(row)),
      activity: [...this.activity.list({}, { page: 1, pageSize: DASHBOARD_ACTIVITY_COUNT }).items],
      expiringKeys: [...this.expiringKeys(serverRows)],
      largestBuckets: [
        ...this.inventory.list(
          { sort: 'size' },
          { page: 1, pageSize: DASHBOARD_LARGEST_BUCKET_COUNT },
        ),
      ],
      incidents: this.incidents(serverRows),
    };
  }

  /* ------------------------------- totals --------------------------- */

  private async totals(
    serverRows: readonly ServerRow[],
    growth: readonly { t: string; bucketsBytes: number }[],
  ): Promise<DashboardTotals> {
    // One aggregate query over the whole cache, not a reduce over every bucket.
    const summary = this.inventory.summary({});
    const counts = await this.iamStats.counts();

    return {
      // The operator's own data, summed from the bucket cache. `byServer[]`'s
      // `usedBytes` is the server's reported capacity use and is a different
      // number on purpose — see the contract.
      bucketsBytes: summary.sizeBytes,
      capacityBytes: sumOrNull(serverRows, (row) => row.capacityTotalBytes),
      objects: summary.objects,
      buckets: summary.buckets,
      bucketsDelta7dBytes: deltaOver(growth, GROWTH_DELTA_DAYS),
      objectsDeltaToday: this.objectsDeltaToday(),
      users: counts.users,
      accessKeys: counts.accessKeys,
      servers: {
        total: serverRows.length,
        healthy: serverRows.filter((row) => row.status === 'healthy').length,
        degraded: serverRows.filter((row) => row.status === 'degraded').length,
        offline: serverRows.filter((row) => row.status === 'offline').length,
      },
      nearQuotaBuckets: summary.nearQuota,
    };
  }

  /**
   * Installation-wide daily totals from `bucket_size_daily`. The series is as long
   * as the samples go, not padded to 30 points: a two-day-old install showing 28
   * zeroes followed by its real size reads as a cliff that never happened.
   */
  private growth(): readonly { t: string; bucketsBytes: number }[] {
    return this.inventory.dailyTotals(DASHBOARD_GROWTH_DAYS).map((point) => ({
      // The samples are keyed by UTC day; the contract wants a date-time.
      t: `${point.day}T00:00:00.000Z`,
      bucketsBytes: point.usedBytes,
    }));
  }

  /**
   * `null` when there is no sample from yesterday to compare against — which is
   * the honest answer on a fresh install, and different from "nothing changed".
   */
  private objectsDeltaToday(): number | null {
    const samples = this.inventory.dailyObjectTotals(2);
    if (samples.length < 2) return null;
    const previous = samples[samples.length - 2];
    const latest = samples[samples.length - 1];
    if (previous === undefined || latest === undefined) return null;
    return latest.objects - previous.objects;
  }

  /* ------------------------------ incidents ------------------------- */

  /**
   * Servers that are not healthy, with when they stopped being. `since` comes from
   * the last health event of that kind rather than from `lastCheckedAt`: an
   * operator wants "down since 03:14", not "checked 5 seconds ago".
   */
  private incidents(serverRows: readonly ServerRow[]): Dashboard['incidents'] {
    const unhealthy = serverRows.filter(
      (row) => row.status === 'offline' || row.status === 'degraded',
    );

    return unhealthy.map((row) => {
      const events = this.servers.listHealthEvents(row.id, 20);
      const kind = row.status === 'offline' ? 'down' : 'degraded';
      const match = events.find((event) => event.kind === kind);
      return {
        serverId: row.id,
        serverName: row.name,
        status: row.status as ServerStatus,
        detail: row.statusDetail,
        since: match?.at ?? row.lastCheckedAt ?? row.updatedAt,
      };
    });
  }

  /* ---------------------------- expiring keys ----------------------- */

  /**
   * Keys expiring inside the window, from `key_meta` — the table the IAM wave
   * writes and the expiry sweep reads. It is deliberately not a fan-out to every
   * provider: an expiry is either the provider's (mirrored into `key_meta` when the
   * key was listed) or storage-io's own, and both are in this table.
   *
   * A key whose server row is gone is skipped rather than shown without a name.
   */
  private expiringKeys(serverRows: readonly ServerRow[]): readonly AccessKey[] {
    const now = new Date();
    const until = new Date(now.getTime() + DASHBOARD_EXPIRING_KEY_DAYS * DAY_MS);
    const rows = this.keyMeta.expiringWithin(now.toISOString(), until.toISOString());
    if (rows.length === 0) return [];

    const byId = new Map(serverRows.map((row) => [row.id, row]));
    // One registry call per server rather than one per key: the ids are already
    // there for any key that has been listed, and this is a page-load path.
    const keyIds = this.keyIdsOf(rows);

    const keys: AccessKey[] = [];
    for (const meta of rows) {
      const server = byId.get(meta.serverId);
      if (server === undefined) continue;

      const lookup = keyIdKey(meta.serverId, meta.accessKeyId);
      const identity = {
        id: requireId(keyIds, lookup),
        serverId: server.id,
        serverName: server.name,
        provider: server.provider as Provider,
      };
      keys.push(toAccessKey(identity, rawFromMeta(meta), meta, now));
    }
    return keys;
  }

  /**
   * The opaque id of every key in `rows`, keyed by server and access key id. One
   * registry call per server rather than one per key: the ids are already there
   * for any key that has been listed, and this is a page-load path.
   */
  private keyIdsOf(rows: readonly KeyMetaRow[]): ReadonlyMap<string, string> {
    const byServer = new Map<string, string[]>();
    for (const meta of rows) {
      const existing = byServer.get(meta.serverId);
      if (existing === undefined) byServer.set(meta.serverId, [meta.accessKeyId]);
      else existing.push(meta.accessKeyId);
    }

    const result = new Map<string, string>();
    for (const [serverId, accessKeyIds] of byServer) {
      const ids = this.entities.idsFor(serverId, 'key', accessKeyIds);
      for (const [accessKeyId, id] of ids) result.set(keyIdKey(serverId, accessKeyId), id);
    }
    return result;
  }
}

/* ------------------------------ helpers --------------------------- */

/** A key's identity across servers, for the flat lookup `expiringKeys` builds. */
const keyIdKey = (serverId: string, accessKeyId: string): string =>
  `${serverId}\u0000${accessKeyId}`;

/**
 * `key_meta` is the only source here, so the "provider's view" handed to the
 * mapper is built from it. `enabled` follows the stored status, which is what the
 * sweep last set or observed — the mapper then applies the expiry rule on top, so a
 * key already past its date reads as `expired` rather than `active`.
 */
function rawFromMeta(meta: KeyMetaRow): Parameters<typeof toAccessKey>[1] {
  return {
    accessKeyId: meta.accessKeyId,
    userName: meta.userName,
    name: meta.name,
    enabled: meta.status === 'active',
    restricted: meta.restricted,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    lastUsedAt: meta.lastUsedAt,
  };
}

/** `null` when not one row reported a number — "unknown", not "zero". */
function sumOrNull<T>(items: readonly T[], pick: (item: T) => number | null): number | null {
  let total = 0;
  let sawOne = false;
  for (const item of items) {
    const value = pick(item);
    if (value === null) continue;
    total += value;
    sawOne = true;
  }
  return sawOne ? total : null;
}

/**
 * The change over the last `days` of samples. Zero when there is nothing to
 * compare against, because the contract's `bucketsDelta7dBytes` is a number and
 * "no change" is the only truthful number to show for an install with one sample.
 */
function deltaOver(series: readonly { t: string; bucketsBytes: number }[], days: number): number {
  const latest = series[series.length - 1];
  if (latest === undefined) return 0;

  const cutoff = Date.parse(latest.t) - days * DAY_MS;
  // The oldest sample at or after the cutoff; falling back to the oldest sample
  // there is, so a 3-day-old install reports its 3-day growth rather than zero.
  const baseline = series.find((point) => Date.parse(point.t) >= cutoff) ?? series[0] ?? latest;
  return latest.bucketsBytes - baseline.bucketsBytes;
}
