import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { AccessKey } from '@storage-io/contracts';
import { AppConfigService } from '../../config/app-config.service';
import { ServerRepository } from '../../servers/server.repository';
import { ProviderRegistryService } from '../../providers/provider-registry.service';
import { KeyMetaRepository } from './key-meta.repository';
import { toAccessKey } from './access-key.mapper';

/**
 * The S3-user and access-key totals the dashboard shows, and the per-server user
 * count on the server list.
 *
 * `GET /dashboard` must not fan out to every storage server, so the numbers are a
 * cache: a snapshot refreshed on a schedule, and computed once on the first call if
 * the process has just started. `counts()` is therefore always cheap and may be a
 * few minutes old — which is the right trade for a headline figure, and is why
 * `at` is part of the answer.
 *
 * `Server.counts.users` comes from the same sweep: the `user_count` column on
 * `servers` is written here, so the server list shows a real number rather than
 * the `null` it had before any IAM driver existed.
 */

export interface IamCounts {
  readonly users: number;
  readonly accessKeys: number;
  /** When the snapshot was taken; null before the first sweep. */
  readonly at: string | null;
}

const EMPTY: IamCounts = { users: 0, accessKeys: 0, at: null };

/** Long enough for the health checker's first pass to settle the capabilities. */
const FIRST_SWEEP_DELAY_MS = 8_000;

@Injectable()
export class IamStatsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(IamStatsService.name);
  private snapshot: IamCounts = EMPTY;
  /** Guards against two callers refreshing at once on a cold start. */
  private inFlight: Promise<IamCounts> | null = null;
  private firstSweep: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly servers: ServerRepository,
    private readonly registry: ProviderRegistryService,
    private readonly keyMeta: KeyMetaRepository,
  ) {}

  /**
   * The cached totals, computing them once if nothing has been cached yet. The
   * dashboard awaits this, so a cold first request is one fan-out and every later
   * one is free.
   */
  async counts(): Promise<IamCounts> {
    if (this.snapshot.at !== null) return this.snapshot;
    return this.refresh();
  }

  /** The snapshot as it stands, without triggering work. */
  cached(): IamCounts {
    return this.snapshot;
  }

  /**
   * The first sweep runs shortly after boot rather than ten minutes later, so
   * `Server.counts.users` is a number on the first page an operator opens.
   *
   * It is deferred rather than awaited: `onApplicationBootstrap` blocks the port
   * from opening, and fanning out to every storage server is not something to make
   * `/health` wait for. The timer is owned and its failure is observed, so this is
   * not a fire-and-forget promise; the handle is cleared on shutdown.
   */
  onApplicationBootstrap(): void {
    if (!this.config.iamSchedulerEnabled) return;
    this.firstSweep = setTimeout(() => {
      this.refresh().catch((error: unknown) => {
        this.log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'The first IAM count sweep failed; the schedule retries',
        );
      });
    }, FIRST_SWEEP_DELAY_MS);
    // A pending timer must not hold the process open on a one-shot run.
    this.firstSweep.unref();
  }

  onApplicationShutdown(): void {
    if (this.firstSweep === null) return;
    clearTimeout(this.firstSweep);
    this.firstSweep = null;
  }

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'iam-counts' })
  async scheduledRefresh(): Promise<void> {
    if (!this.config.iamSchedulerEnabled) return;
    await this.refresh();
  }

  /**
   * Re-counts one server's users and stores it on the row. Called after a user is
   * created or deleted, so the server list is right immediately instead of at the
   * next sweep — one admin call, on a page the operator is already on.
   *
   * It never throws: the count is a decoration on a mutation that already succeeded.
   */
  async refreshServer(serverId: string): Promise<void> {
    const row = this.servers.findByIdOrName(serverId);
    if (row === null) return;
    if (row.capabilities['iamUsers'] !== 'supported') return;

    try {
      const connection = this.servers.toConnection(row);
      const users = await this.registry.iamUsersFor(connection).list(connection);
      this.servers.update(row.id, { userCount: users.length });
    } catch (error) {
      this.log.debug(
        { server: row.name, err: error instanceof Error ? error.message : String(error) },
        "Could not refresh one server's user count",
      );
    }
  }

  async refresh(): Promise<IamCounts> {
    const existing = this.inFlight;
    if (existing !== null) return existing;

    const work = this.compute();
    this.inFlight = work;
    try {
      const counts = await work;
      this.snapshot = counts;
      return counts;
    } finally {
      this.inFlight = null;
    }
  }

  private async compute(): Promise<IamCounts> {
    const rows = this.servers.findAll();
    const now = new Date();

    const perServer = await Promise.all(
      rows.map(async (row) => {
        const wantsUsers = row.capabilities['iamUsers'] === 'supported';
        const wantsKeys = row.capabilities['accessKeys'] === 'supported';
        if (!wantsUsers && !wantsKeys) return { users: 0, keys: 0, wroteUsers: false };

        try {
          const connection = this.servers.toConnection(row);
          const users = wantsUsers
            ? await this.registry.iamUsersFor(connection).list(connection)
            : [];
          const rawKeys = wantsKeys
            ? await this.registry.iamKeysFor(connection).list(connection)
            : [];

          // Counting through the mapper rather than the raw list so an expired key
          // is not counted as one an operator can use.
          const meta = this.keyMeta.byServer(row.id);
          const stamp = { serverId: row.id, serverName: row.name, provider: row.provider };
          const keys: AccessKey[] = rawKeys.map((raw) =>
            toAccessKey(
              { ...stamp, provider: row.provider as AccessKey['provider'] },
              raw,
              meta.get(raw.accessKeyId),
              now,
            ),
          );

          if (wantsUsers) this.servers.update(row.id, { userCount: users.length });
          return { users: users.length, keys: keys.length, wroteUsers: wantsUsers };
        } catch (error) {
          // A server that cannot be reached contributes nothing rather than
          // failing the whole figure; its own status already says it is down.
          this.log.debug(
            { server: row.name, err: error instanceof Error ? error.message : String(error) },
            'Skipped a server while refreshing IAM counts',
          );
          return { users: 0, keys: 0, wroteUsers: false };
        }
      }),
    );

    return {
      users: perServer.reduce((total, entry) => total + entry.users, 0),
      accessKeys: perServer.reduce((total, entry) => total + entry.keys, 0),
      at: now.toISOString(),
    };
  }
}
