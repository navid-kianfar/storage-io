import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ListBucketsCommand } from '@aws-sdk/client-s3';
import type { ServerStatus } from '@storage-io/contracts';
import { AppConfigService } from '../config/app-config.service';
import { ActivityService } from '../activity/activity.service';
import { EventBusService } from '../events/event-bus.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { ServerRepository } from './server.repository';
import { TrafficSamplerService } from './traffic-sampler.service';
import type { ServerRow } from '../db/schema';

/** How often the scheduler wakes to see which servers are due. */
const TICK_INTERVAL_MS = 5_000;
/** Capacity is snapshotted hourly, for the 24h/7d/30d charts. */
const CAPACITY_SNAPSHOT_INTERVAL_MS = 3_600_000;

/**
 * Per-server health checking.
 *
 * The scheduler is one interval that asks which servers are due, rather than a
 * timer per server: a timer per server means re-registering on every interval
 * change, and this way an edit to `healthIntervalSec` takes effect on the next
 * tick with no bookkeeping.
 *
 * A check is a signed `ListBuckets`, which proves DNS, TCP, TLS, credentials and
 * the S3 API in one round trip and gives the latency the charts plot. It is
 * deliberately not the full connection test: that runs on demand and takes
 * seconds.
 *
 * On a status transition it records a health event and an activity entry, pushes
 * `server.health` over SSE, and raises a notification when a server goes down.
 */
@Injectable()
export class HealthCheckerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(HealthCheckerService.name);
  /** Guards against overlapping checks of the same server. */
  private readonly inFlight = new Set<string>();
  private readonly lastCheckedAt = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly repository: ServerRepository,
    private readonly registry: ProviderRegistryService,
    private readonly settings: SettingsService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly bus: EventBusService,
    private readonly config: AppConfigService,
    private readonly traffic: TrafficSamplerService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.healthCheckerEnabled) {
      this.logger.log('Health checker disabled by HEALTH_CHECKER_ENABLED');
      return;
    }
    this.logger.log(`Health checker running every ${TICK_INTERVAL_MS} ms`);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
  }

  /**
   * `@Interval` rather than a cron: the cadence is sub-minute and the schedule
   * module keeps the handle, so shutdown cancels it without extra code.
   */
  @Interval(TICK_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.stopped || !this.config.healthCheckerEnabled) return;

    const due = this.repository.findAll().filter((row) => this.isDue(row));
    if (due.length === 0) return;

    // Sequential on purpose: a dozen servers checked in parallel on a small box
    // makes every latency reading a measure of our own contention.
    for (const row of due) {
      if (this.stopped) return;
      await this.checkServer(row);
    }
  }

  /** `POST /servers/:id/check` and `POST /servers/check-all` both come here. */
  async checkNow(serverId: string): Promise<void> {
    const row = this.repository.findByIdOrName(serverId);
    if (row === null) return;
    await this.checkServer(row);
  }

  async checkAll(): Promise<number> {
    const rows = this.repository.findAll();
    for (const row of rows) {
      if (this.stopped) break;
      await this.checkServer(row);
    }
    return rows.length;
  }

  private isDue(row: ServerRow): boolean {
    // A server in maintenance is not probed: that is what maintenance means.
    if (row.maintenance) return false;

    const last = this.lastCheckedAt.get(row.id);
    if (last === undefined) {
      // Fall back to the stored timestamp, so a restart does not re-check
      // everything at once.
      const stored = row.lastCheckedAt === null ? 0 : Date.parse(row.lastCheckedAt);
      return Date.now() - stored >= row.healthIntervalSec * 1000;
    }
    return Date.now() - last >= row.healthIntervalSec * 1000;
  }

  private async checkServer(row: ServerRow): Promise<void> {
    if (this.inFlight.has(row.id)) return;
    this.inFlight.add(row.id);
    this.lastCheckedAt.set(row.id, Date.now());

    try {
      await this.runCheck(row);
    } catch (error) {
      // A failure inside the checker itself (a decryption error, say) must not
      // kill the interval — @nestjs/schedule would keep calling it, but a thrown
      // rejection here becomes an unhandled one.
      this.logger.error(
        { server: row.name, err: error instanceof Error ? error.message : String(error) },
        'Health check raised an unexpected error',
      );
    } finally {
      this.inFlight.delete(row.id);
    }
  }

  private async runCheck(row: ServerRow): Promise<void> {
    const previousStatus = row.status as ServerStatus;
    const latencyWarnMs = this.settings.latencyWarnMs;

    let connection;
    try {
      connection = this.repository.toConnection(row);
    } catch (error) {
      // The secret cannot be decrypted: the server is unusable and saying
      // "offline" would send the operator looking at the network.
      this.applyResult(row, previousStatus, {
        status: 'offline',
        detail: 'The stored credentials could not be decrypted.',
        latencyMs: null,
        reachable: false,
      });
      this.logger.error(
        { server: row.name, err: error instanceof Error ? error.message : String(error) },
        'Health check could not build a connection',
      );
      return;
    }

    const driver = this.registry.driverFor(connection.provider);
    const client = driver.createS3Client(connection);

    const started = Date.now();
    let bucketCount: number | null = null;
    try {
      const response = await client.send(new ListBucketsCommand({}));
      bucketCount = (response.Buckets ?? []).length;
    } catch (error) {
      const latencyMs = Date.now() - started;
      this.repository.recordLatency(row.id, latencyMs, false);
      this.applyResult(row, previousStatus, {
        status: 'offline',
        detail: shortReason(error),
        latencyMs,
        reachable: false,
      });
      return;
    }

    const latencyMs = Date.now() - started;
    this.repository.recordLatency(row.id, latencyMs, true);

    const isSlow = latencyMs > latencyWarnMs;
    this.applyResult(row, previousStatus, {
      status: isSlow ? 'degraded' : 'healthy',
      detail: isSlow ? `Latency ${latencyMs} ms exceeds the ${latencyWarnMs} ms threshold` : null,
      latencyMs,
      reachable: true,
      bucketCount,
    });

    // Both ride the successful check: the connection is already decrypted and the
    // server has just proved it answers. Neither can fail the check.
    await this.traffic.sample(row, connection);
    await this.snapshotCapacity(row, connection);
  }

  private applyResult(
    row: ServerRow,
    previousStatus: ServerStatus,
    result: {
      readonly status: ServerStatus;
      readonly detail: string | null;
      readonly latencyMs: number | null;
      readonly reachable: boolean;
      readonly bucketCount?: number | null;
    },
  ): void {
    const now = new Date().toISOString();

    this.repository.update(row.id, {
      status: result.status,
      statusDetail: result.detail,
      latencyMs: result.latencyMs,
      lastCheckedAt: now,
      ...(result.reachable ? { lastSeenAt: now } : {}),
      ...(result.bucketCount === undefined || result.bucketCount === null
        ? {}
        : { bucketCount: result.bucketCount }),
    });

    if (result.status === previousStatus) return;

    const kind = eventKindFor(result.status);
    this.repository.recordHealthEvent(row.id, kind, result.detail);

    this.bus.publish('server.health', {
      serverId: row.id,
      serverName: row.name,
      status: result.status,
      previousStatus,
      statusDetail: result.detail,
      latencyMs: result.latencyMs,
      at: now,
    });

    this.activity.record({
      category: 'servers',
      action: `server.${kind}`,
      title: `${row.name} is ${result.status}`,
      actor: { type: 'system', name: 'health-checker' },
      result: result.status === 'healthy' ? 'success' : 'warning',
      target: row.name,
      serverId: row.id,
      serverName: row.name,
      details: { previousStatus, status: result.status, detail: result.detail },
    });

    // Only a transition into offline is worth waking someone for; recovering is
    // visible in the UI and does not need a notification of its own.
    if (result.status === 'offline') {
      this.notifications.raise({
        level: 'error',
        title: `${row.name} is offline`,
        detail: result.detail ?? 'The server stopped responding.',
        href: `/servers/${row.name}`,
        ruleKey: 'server.offline',
        // A flapping server transitions into offline repeatedly; one alert per
        // server per dedup window is what an operator can act on.
        fingerprint: `server.offline:${row.id}`,
      });
    }

    this.logger.log(
      { server: row.name, from: previousStatus, to: result.status },
      'Server status changed',
    );
  }

  /**
   * Hourly, and only where the provider reports usage natively — an inventory
   * scan on every health tick would be the expensive mistake this avoids.
   */
  private async snapshotCapacity(
    row: ServerRow,
    connection: ReturnType<ServerRepository['toConnection']>,
  ): Promise<void> {
    if (!this.repository.capacitySnapshotIsStale(row.id, CAPACITY_SNAPSHOT_INTERVAL_MS)) return;

    const driver = this.registry.driverFor(connection.provider);
    if (driver.serverInfo === undefined && driver.usage === undefined) return;

    try {
      if (driver.serverInfo !== undefined) {
        const info = await driver.serverInfo(connection);
        if (info.capacity.usedBytes !== null) {
          this.repository.recordCapacity(row.id, info.capacity.usedBytes, info.capacity.totalBytes);
        }
        this.repository.update(row.id, {
          version: info.version ?? row.version,
          capacityUsedBytes: info.capacity.usedBytes,
          capacityTotalBytes: info.capacity.totalBytes,
          objectCount: info.objectCount,
          ...(info.bucketCount === null ? {} : { bucketCount: info.bucketCount }),
        });
        return;
      }

      const usage = await driver.usage?.getUsage(connection);
      if (usage?.usedBytes !== undefined && usage.usedBytes !== null) {
        this.repository.recordCapacity(row.id, usage.usedBytes, null);
        this.repository.update(row.id, {
          capacityUsedBytes: usage.usedBytes,
          objectCount: usage.objectCount,
        });
      }
    } catch (error) {
      // A usage call failing does not change the server's health: it answered
      // ListBuckets. Log and carry on.
      this.logger.debug(
        { server: row.name, err: error instanceof Error ? error.message : String(error) },
        'Capacity snapshot failed',
      );
    }
  }
}

/* ------------------------------ helpers --------------------------- */

const eventKindFor = (status: ServerStatus): 'up' | 'down' | 'degraded' | 'check' => {
  switch (status) {
    case 'healthy':
      return 'up';
    case 'offline':
      return 'down';
    case 'degraded':
      return 'degraded';
    case 'maintenance':
    case 'unknown':
      return 'check';
  }
};

/** A short, safe reason — the full error goes to the log, not to a client. */
function shortReason(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'The server did not respond.';
  const shape = error as { name?: unknown; code?: unknown };
  const name = typeof shape.name === 'string' ? shape.name : null;
  const code = typeof shape.code === 'string' ? shape.code : null;
  const label = code ?? name;
  return label === null ? 'The server did not respond.' : `The server did not respond (${label}).`;
}
