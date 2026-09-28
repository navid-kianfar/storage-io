import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, isNotNull, like, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  emptyCapabilityMap,
  type CapabilityMap,
  type CapabilityState,
  type ListServersQuery,
  type Provider,
  type Server,
  type ServerHealthEvent,
  type ServerOptions,
  type ServerStatus,
  type TrafficPoint,
} from '@storage-io/contracts';
import { DB } from '../db/db.module';
import type { AppDatabase } from '../db/migrate';
import {
  healthEvents,
  metricsCapacity,
  metricsLatency,
  metricsTraffic,
  serverChecks,
  servers,
  type MetricsTrafficRow,
  type ServerRow,
} from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import type { ServerConnection } from '../providers/provider-driver';
import { escapeLike } from '../activity/activity.service';

const UPTIME_WINDOW_HOURS = 24;

/** What `recordTraffic` stores: the provider's counters plus the derived rates. */
export interface TrafficSample {
  readonly requests: number;
  readonly errors: number;
  readonly rxBytes: number;
  readonly txBytes: number;
  readonly requestsPerSec: number | null;
  readonly errorsPerSec: number | null;
  readonly rxBytesPerSec: number | null;
  readonly txBytesPerSec: number | null;
}

/**
 * All SQL for servers and their metrics. The service above it holds the
 * behaviour; this file holds the queries and the row↔contract mapping, so a
 * column rename touches one place.
 */
@Injectable()
export class ServerRepository {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    private readonly crypto: CryptoService,
  ) {}

  findAll(filters: ListServersQuery = {}): readonly ServerRow[] {
    const conditions: SQL[] = [];
    if (filters.status !== undefined) conditions.push(eq(servers.status, filters.status));
    if (filters.provider !== undefined) conditions.push(eq(servers.provider, filters.provider));
    if (filters.q !== undefined && filters.q.length > 0) {
      const needle = `%${escapeLike(filters.q)}%`;
      const search = or(like(servers.name, needle), like(servers.endpoint, needle));
      if (search !== undefined) conditions.push(search);
    }

    return this.db
      .select()
      .from(servers)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(servers.name)
      .all();
  }

  /** `:id` in the contract accepts either the id or the unique name. */
  findByIdOrName(idOrName: string): ServerRow | null {
    const [row] = this.db
      .select()
      .from(servers)
      .where(or(eq(servers.id, idOrName), eq(servers.name, idOrName)))
      .limit(1)
      .all();
    return row ?? null;
  }

  findByName(name: string): ServerRow | null {
    const [row] = this.db.select().from(servers).where(eq(servers.name, name)).limit(1).all();
    return row ?? null;
  }

  insert(row: typeof servers.$inferInsert): ServerRow {
    const [inserted] = this.db.insert(servers).values(row).returning().all();
    if (inserted === undefined) throw new Error('Insert returned no row.');
    return inserted;
  }

  update(id: string, patch: Partial<typeof servers.$inferInsert>): ServerRow | null {
    const [updated] = this.db
      .update(servers)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(servers.id, id))
      .returning()
      .all();
    return updated ?? null;
  }

  /** Cascades to checks, events and metrics through the schema's references. */
  delete(id: string): boolean {
    const result = this.db.delete(servers).where(eq(servers.id, id)).run();
    return result.changes > 0;
  }

  /* --------------------------- check results ---------------------- */

  /** Replaces the previous result set in one transaction. */
  replaceChecks(
    serverId: string,
    checks: readonly {
      id: string;
      label: string;
      status: string;
      detail: string | null;
      durationMs: number;
    }[],
  ): void {
    const at = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.delete(serverChecks).where(eq(serverChecks.serverId, serverId)).run();
      if (checks.length === 0) return;
      tx.insert(serverChecks)
        .values(
          checks.map((check) => ({
            id: this.crypto.newId(),
            serverId,
            checkId: check.id,
            label: check.label,
            status: check.status,
            detail: check.detail,
            durationMs: check.durationMs,
            at,
          })),
        )
        .run();
    });
  }

  /* --------------------------- health events ---------------------- */

  recordHealthEvent(serverId: string, kind: string, detail: string | null): void {
    this.db
      .insert(healthEvents)
      .values({ id: this.crypto.newId(), serverId, kind, detail, at: new Date().toISOString() })
      .run();
  }

  listHealthEvents(serverId: string, limit: number): readonly ServerHealthEvent[] {
    const rows = this.db
      .select()
      .from(healthEvents)
      .where(eq(healthEvents.serverId, serverId))
      .orderBy(desc(healthEvents.at))
      .limit(limit)
      .all();

    return rows.map((row) => ({
      at: row.at,
      kind: row.kind as ServerHealthEvent['kind'],
      detail: row.detail,
    }));
  }

  /* ------------------------------ metrics ------------------------- */

  recordLatency(serverId: string, ms: number, reachable: boolean): void {
    this.db
      .insert(metricsLatency)
      .values({ serverId, at: new Date().toISOString(), ms, reachable })
      .run();
  }

  recordCapacity(serverId: string, usedBytes: number, totalBytes: number | null): void {
    this.db
      .insert(metricsCapacity)
      .values({ serverId, at: new Date().toISOString(), usedBytes, totalBytes })
      .run();
  }

  /** True when the most recent snapshot is older than `maxAgeMs`. */
  capacitySnapshotIsStale(serverId: string, maxAgeMs: number): boolean {
    const [row] = this.db
      .select({ at: metricsCapacity.at })
      .from(metricsCapacity)
      .where(eq(metricsCapacity.serverId, serverId))
      .orderBy(desc(metricsCapacity.at))
      .limit(1)
      .all();
    if (row === undefined) return true;
    return Date.now() - Date.parse(row.at) >= maxAgeMs;
  }

  capacitySince(
    serverId: string,
    since: string,
  ): readonly { at: string; usedBytes: number; totalBytes: number | null }[] {
    return this.db
      .select({
        at: metricsCapacity.at,
        usedBytes: metricsCapacity.usedBytes,
        totalBytes: metricsCapacity.totalBytes,
      })
      .from(metricsCapacity)
      .where(and(eq(metricsCapacity.serverId, serverId), gte(metricsCapacity.at, since)))
      .orderBy(metricsCapacity.at)
      .all();
  }

  latencySince(serverId: string, since: string): readonly { at: string; ms: number }[] {
    return this.db
      .select({ at: metricsLatency.at, ms: metricsLatency.ms })
      .from(metricsLatency)
      .where(
        and(
          eq(metricsLatency.serverId, serverId),
          gte(metricsLatency.at, since),
          eq(metricsLatency.reachable, true),
        ),
      )
      .orderBy(metricsLatency.at)
      .all();
  }

  /**
   * Uptime as the share of reachable checks over the window, computed in SQL —
   * loading a day of checks to count them in JavaScript would be the N+1 of
   * aggregates.
   */
  uptimeRatio(serverId: string, hours = UPTIME_WINDOW_HOURS): number | null {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const [row] = this.db
      .select({
        total: sql<number>`count(*)`,
        up: sql<number>`sum(case when ${metricsLatency.reachable} then 1 else 0 end)`,
      })
      .from(metricsLatency)
      .where(and(eq(metricsLatency.serverId, serverId), gte(metricsLatency.at, since)))
      .all();

    if (row === undefined || row.total === 0) return null;
    return (row.up ?? 0) / row.total;
  }

  /* ------------------------------ traffic ------------------------- */

  /**
   * One traffic sample. The counters are what the provider reported; the rates
   * are `null` on the first sample of a series and whenever the counters went
   * backwards, which is how a provider restart is recorded rather than drawn as
   * a spike.
   */
  recordTraffic(serverId: string, sample: TrafficSample): void {
    this.db
      .insert(metricsTraffic)
      .values({
        serverId,
        at: new Date().toISOString(),
        requests: sample.requests,
        errors: sample.errors,
        rxBytes: sample.rxBytes,
        txBytes: sample.txBytes,
        requestsPerSec: sample.requestsPerSec,
        errorsPerSec: sample.errorsPerSec,
        rxBytesPerSec: sample.rxBytesPerSec,
        txBytesPerSec: sample.txBytesPerSec,
      })
      .run();
  }

  /** The previous sample, which the next one's rates are derived from. */
  lastTrafficSample(serverId: string): MetricsTrafficRow | null {
    const [row] = this.db
      .select()
      .from(metricsTraffic)
      .where(eq(metricsTraffic.serverId, serverId))
      .orderBy(desc(metricsTraffic.at), desc(metricsTraffic.id))
      .limit(1)
      .all();
    return row ?? null;
  }

  /** The chart series. A sample with no rate yet is not a point to draw. */
  trafficSince(serverId: string, since: string): readonly TrafficPoint[] {
    const rows = this.db
      .select({
        at: metricsTraffic.at,
        requestsPerSec: metricsTraffic.requestsPerSec,
        errorsPerSec: metricsTraffic.errorsPerSec,
        rxBytesPerSec: metricsTraffic.rxBytesPerSec,
        txBytesPerSec: metricsTraffic.txBytesPerSec,
      })
      .from(metricsTraffic)
      .where(
        and(
          eq(metricsTraffic.serverId, serverId),
          gte(metricsTraffic.at, since),
          isNotNull(metricsTraffic.requestsPerSec),
        ),
      )
      .orderBy(metricsTraffic.at)
      .all();

    return rows.map((row) => ({
      t: row.at,
      requestsPerSec: row.requestsPerSec ?? 0,
      errorsPerSec: row.errorsPerSec ?? 0,
      rxBytesPerSec: row.rxBytesPerSec ?? 0,
      txBytesPerSec: row.txBytesPerSec ?? 0,
    }));
  }

  /** True when this server has ever reported traffic — `traffic: null` otherwise. */
  hasTrafficSamples(serverId: string): boolean {
    const [row] = this.db
      .select({ id: metricsTraffic.id })
      .from(metricsTraffic)
      .where(eq(metricsTraffic.serverId, serverId))
      .limit(1)
      .all();
    return row !== undefined;
  }

  /** Retention sweep for every metric table. */
  deleteMetricsOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    let removed = 0;
    this.db.transaction((tx) => {
      removed += tx.delete(metricsCapacity).where(lt(metricsCapacity.at, cutoff)).run().changes;
      removed += tx.delete(metricsLatency).where(lt(metricsLatency.at, cutoff)).run().changes;
      removed += tx.delete(metricsTraffic).where(lt(metricsTraffic.at, cutoff)).run().changes;
      removed += tx.delete(healthEvents).where(lt(healthEvents.at, cutoff)).run().changes;
    });
    return removed;
  }

  /* ------------------------------ mapping ------------------------- */

  /** Row → contract. The secret is never included, only its mask. */
  toContract(row: ServerRow): Server {
    return {
      id: row.id,
      name: row.name,
      provider: row.provider as Provider,
      endpoint: row.endpoint,
      region: row.region,
      status: row.status as ServerStatus,
      statusDetail: row.statusDetail,
      latencyMs: row.latencyMs,
      lastCheckedAt: row.lastCheckedAt,
      lastSeenAt: row.lastSeenAt,
      version: row.version,
      uptime24h: this.uptimeRatio(row.id),
      capacity: {
        usedBytes: row.capacityUsedBytes,
        totalBytes: row.capacityTotalBytes,
        budget: row.capacityBudget,
      },
      counts: {
        buckets: row.bucketCount,
        users: row.userCount,
        objects: row.objectCount,
      },
      capabilities: toCapabilityMap(row.capabilities),
      options: toOptions(row),
      accessKeyId: row.accessKeyId,
      secretMasked: this.crypto.maskSecret(this.decryptOrMask(row)),
      maintenance: row.maintenance,
      tls: row.endpoint.startsWith('https:'),
      createdAt: row.createdAt,
    };
  }

  /** Row → a connection with decrypted credentials, for driver calls. */
  toConnection(row: ServerRow): ServerConnection {
    return {
      id: row.id,
      name: row.name,
      provider: row.provider as Provider,
      endpoint: row.endpoint,
      region: row.region,
      accessKeyId: row.accessKeyId,
      secretAccessKey: this.crypto.decryptSecret(row.secretEncrypted),
      adminToken:
        row.adminTokenEncrypted === null
          ? null
          : this.crypto.decryptSecret(row.adminTokenEncrypted),
      options: toOptions(row),
    };
  }

  /**
   * A row whose secret cannot be decrypted (APP_SECRET changed) must still be
   * listable — otherwise the operator cannot see or fix the broken server.
   */
  private decryptOrMask(row: ServerRow): string {
    try {
      return this.crypto.decryptSecret(row.secretEncrypted);
    } catch {
      return '';
    }
  }
}

/* ------------------------------ helpers --------------------------- */

const toOptions = (row: ServerRow): ServerOptions => ({
  pathStyle: row.pathStyle,
  tlsVerify: row.tlsVerify,
  caPem: row.caPem,
  adminEndpoint: row.adminEndpoint,
  iamEndpoint: row.iamEndpoint,
  healthIntervalSec: row.healthIntervalSec,
});

const VALID_STATES: readonly CapabilityState[] = ['supported', 'not_configured', 'not_supported'];

/**
 * Fills in any capability the stored map is missing, so a map written by an older
 * version cannot produce `undefined` where the contract promises a state.
 */
function toCapabilityMap(stored: Record<string, string>): CapabilityMap {
  const base = emptyCapabilityMap('not_configured');
  const result: Record<string, CapabilityState> = { ...base };
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in base)) continue;
    if (!VALID_STATES.includes(value as CapabilityState)) continue;
    result[key] = value as CapabilityState;
  }
  return result as CapabilityMap;
}
