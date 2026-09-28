import { Injectable, Logger } from '@nestjs/common';
import {
  SERVER_OPTION_DEFAULTS,
  type CreateServerRequest,
  type ListServersQuery,
  type MetricRange,
  type Server,
  type ServerDrive,
  type ServerHealthEvent,
  type ServerList,
  type ServerMetrics,
  type ServerNode,
  type TestServerResponse,
  type UpdateServerRequest,
} from '@storage-io/contracts';
import { ConflictError, NotFoundError } from '../common/errors/domain.exception';
import { CryptoService } from '../crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { ConnectionTesterService } from '../providers/connection-tester.service';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import type { ServerConnection } from '../providers/provider-driver';
import { ServerRepository } from './server.repository';
import type { ServerRow } from '../db/schema';

const RANGE_HOURS: Readonly<Record<MetricRange, number>> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

/**
 * The business layer for storage servers: creating and editing connections,
 * testing them, and answering the read endpoints. The health checker drives
 * status transitions; this service owns everything a request asks for.
 */
@Injectable()
export class ServersService {
  private readonly logger = new Logger(ServersService.name);

  constructor(
    private readonly repository: ServerRepository,
    private readonly crypto: CryptoService,
    private readonly registry: ProviderRegistryService,
    private readonly tester: ConnectionTesterService,
    private readonly settings: SettingsService,
  ) {}

  list(filters: ListServersQuery): ServerList {
    const rows = this.repository.findAll(filters);
    const items = rows.map((row) => this.repository.toContract(row));
    return { items, total: items.length };
  }

  findOne(idOrName: string): Server {
    return this.repository.toContract(this.requireRow(idOrName));
  }

  /**
   * The secret is encrypted before it reaches the database and the capabilities
   * are probed once at creation, so the server list is useful immediately rather
   * than after the first health tick.
   */
  async create(request: CreateServerRequest): Promise<Server> {
    if (this.repository.findByName(request.name) !== null) {
      throw new ConflictError(`A server named "${request.name}" already exists.`);
    }

    const options = { ...SERVER_OPTION_DEFAULTS, ...request.options };
    const now = new Date().toISOString();

    const inserted = this.repository.insert({
      id: this.crypto.newId(),
      name: request.name,
      provider: request.provider,
      endpoint: normalizeEndpoint(request.endpoint),
      region: request.region,
      accessKeyId: request.accessKeyId,
      secretEncrypted: this.crypto.encryptSecret(request.secretAccessKey),
      adminTokenEncrypted:
        request.options.adminToken === undefined
          ? null
          : this.crypto.encryptSecret(request.options.adminToken),
      pathStyle: options.pathStyle,
      tlsVerify: options.tlsVerify,
      caPem: options.caPem,
      adminEndpoint: options.adminEndpoint,
      iamEndpoint: options.iamEndpoint,
      healthIntervalSec: options.healthIntervalSec,
      createdAt: now,
      updatedAt: now,
    });

    await this.refreshFromTest(inserted);
    return this.repository.toContract(this.requireRow(inserted.id));
  }

  /** Omitting `secretAccessKey` keeps the stored one — per docs/API.md. */
  async update(idOrName: string, request: UpdateServerRequest): Promise<Server> {
    const row = this.requireRow(idOrName);

    if (request.name !== undefined && request.name !== row.name) {
      const clash = this.repository.findByName(request.name);
      if (clash !== null)
        throw new ConflictError(`A server named "${request.name}" already exists.`);
    }

    const patch: Partial<typeof row> = {};
    if (request.name !== undefined) patch.name = request.name;
    if (request.provider !== undefined) patch.provider = request.provider;
    if (request.endpoint !== undefined) patch.endpoint = normalizeEndpoint(request.endpoint);
    if (request.region !== undefined) patch.region = request.region;
    if (request.accessKeyId !== undefined) patch.accessKeyId = request.accessKeyId;
    if (request.secretAccessKey !== undefined) {
      patch.secretEncrypted = this.crypto.encryptSecret(request.secretAccessKey);
    }

    const options = request.options;
    if (options !== undefined) {
      if (options.pathStyle !== undefined) patch.pathStyle = options.pathStyle;
      if (options.tlsVerify !== undefined) patch.tlsVerify = options.tlsVerify;
      if (options.caPem !== undefined) patch.caPem = options.caPem;
      if (options.adminEndpoint !== undefined) patch.adminEndpoint = options.adminEndpoint;
      if (options.iamEndpoint !== undefined) patch.iamEndpoint = options.iamEndpoint;
      if (options.healthIntervalSec !== undefined) {
        patch.healthIntervalSec = options.healthIntervalSec;
      }
      if (options.adminToken !== undefined) {
        patch.adminTokenEncrypted = this.crypto.encryptSecret(options.adminToken);
      }
    }

    const updated = this.repository.update(row.id, patch);
    if (updated === null) throw new NotFoundError('No such server.');

    // Connection details changed, so the cached S3 client and admin agent are
    // stale — dropping them here is what makes an endpoint edit take effect.
    this.registry.evict(row.id);
    await this.refreshFromTest(updated);

    return this.repository.toContract(this.requireRow(row.id));
  }

  delete(idOrName: string): void {
    const row = this.requireRow(idOrName);
    this.registry.evict(row.id);
    const removed = this.repository.delete(row.id);
    if (!removed) throw new NotFoundError('No such server.');
    this.logger.log({ server: row.name }, 'Server connection removed');
  }

  /** `POST /servers/test`: unsaved details, nothing written. */
  async testUnsaved(request: CreateServerRequest): Promise<TestServerResponse> {
    const options = { ...SERVER_OPTION_DEFAULTS, ...request.options };
    const connection: ServerConnection = {
      // No row yet; the id only keys caches, which a transient test bypasses.
      id: `unsaved:${request.name}`,
      name: request.name,
      provider: request.provider,
      endpoint: normalizeEndpoint(request.endpoint),
      region: request.region,
      accessKeyId: request.accessKeyId,
      secretAccessKey: request.secretAccessKey,
      adminToken: request.options.adminToken ?? null,
      options,
    };
    return this.tester.test(connection, true);
  }

  /** `POST /servers/:id/test`: the saved connection, and the result is stored. */
  async testSaved(idOrName: string): Promise<TestServerResponse> {
    const row = this.requireRow(idOrName);
    const result = await this.tester.test(this.repository.toConnection(row), false);
    this.repository.replaceChecks(row.id, result.checks);
    this.repository.update(row.id, {
      capabilities: result.capabilities,
      version: result.version,
      bucketCount: result.bucketCount ?? row.bucketCount,
    });
    return result;
  }

  setMaintenance(idOrName: string, enabled: boolean): Server {
    const row = this.requireRow(idOrName);
    const updated = this.repository.update(row.id, {
      maintenance: enabled,
      // Leaving a stale `healthy` behind while in maintenance would be a lie;
      // the checker sets a real status again on the next pass after it is lifted.
      status: enabled ? 'maintenance' : 'unknown',
      statusDetail: enabled ? 'Maintenance mode is on' : null,
    });
    if (updated === null) throw new NotFoundError('No such server.');

    this.repository.recordHealthEvent(
      row.id,
      enabled ? 'degraded' : 'check',
      enabled ? 'Maintenance mode enabled' : 'Maintenance mode disabled',
    );
    return this.repository.toContract(updated);
  }

  metrics(idOrName: string, range: MetricRange): ServerMetrics {
    const row = this.requireRow(idOrName);
    const hours = RANGE_HOURS[range];
    const since = new Date(Date.now() - hours * 3600_000).toISOString();

    const capacity = this.repository.capacitySince(row.id, since).map((point) => ({
      t: point.at,
      usedBytes: point.usedBytes,
      totalBytes: point.totalBytes,
    }));
    const latency = this.repository
      .latencySince(row.id, since)
      .map((point) => ({ t: point.at, ms: point.ms }));

    return {
      capacity,
      latency,
      uptime: this.repository.uptimeRatio(row.id, hours) ?? 0,
      traffic: this.trafficSeries(row, since),
    };
  }

  /**
   * `null` means "this server has no traffic data", which the chart shows
   * differently from an empty series. A provider whose driver has no metrics
   * endpoint is `null` forever; one that has never been sampled yet is `null`
   * until the first pair of samples, rather than an empty chart that looks like
   * zero traffic.
   */
  private trafficSeries(row: ServerRow, since: string): ServerMetrics['traffic'] {
    if (row.capabilities['traffic'] === 'not_supported') return null;
    if (!this.repository.hasTrafficSamples(row.id)) return null;
    return [...this.repository.trafficSince(row.id, since)];
  }

  async nodes(idOrName: string): Promise<readonly ServerNode[]> {
    const row = this.requireRow(idOrName);
    const connection = this.repository.toConnection(row);
    const driver = this.registry.nodesFor(connection);
    return driver.listNodes(connection);
  }

  async drives(idOrName: string, node: string): Promise<readonly ServerDrive[]> {
    const row = this.requireRow(idOrName);
    const connection = this.repository.toConnection(row);
    const driver = this.registry.nodesFor(connection);
    return driver.listDrives(connection, node);
  }

  events(idOrName: string, limit: number): readonly ServerHealthEvent[] {
    const row = this.requireRow(idOrName);
    return this.repository.listHealthEvents(row.id, limit);
  }

  /** Shared by the create and update paths. */
  private async refreshFromTest(row: ServerRow): Promise<void> {
    try {
      const result = await this.tester.test(this.repository.toConnection(row), false);
      this.repository.replaceChecks(row.id, result.checks);

      const status = statusFromChecks(result);
      const reachable = status !== 'offline';
      // The `auth` check is a signed ListBuckets, so its duration is a real
      // latency reading. Recording it here means a freshly added server shows a
      // latency and an uptime figure straight away instead of blanks until the
      // first scheduled health tick.
      const latencyMs = latencyFromChecks(result);
      const now = new Date().toISOString();

      if (latencyMs !== null) this.repository.recordLatency(row.id, latencyMs, reachable);

      this.repository.update(row.id, {
        capabilities: result.capabilities,
        version: result.version,
        bucketCount: result.bucketCount ?? 0,
        status,
        statusDetail: firstFailureDetail(result),
        latencyMs,
        lastCheckedAt: now,
        ...(reachable ? { lastSeenAt: now } : {}),
      });
    } catch (error) {
      // A server that cannot be reached is still saved: the operator needs the
      // row in order to fix it. The failure is recorded, not raised.
      this.logger.warn(
        { server: row.name, err: error instanceof Error ? error.message : String(error) },
        'Initial connection test failed; the server is saved as offline',
      );
      this.repository.update(row.id, {
        status: 'offline',
        statusDetail: 'The initial connection test failed.',
        lastCheckedAt: new Date().toISOString(),
      });
    }
  }

  private requireRow(idOrName: string): ServerRow {
    const row = this.repository.findByIdOrName(idOrName);
    if (row === null) throw new NotFoundError(`No server named "${idOrName}".`);
    return row;
  }

  /** The health checker needs the settings-wide latency threshold. */
  get latencyWarnMs(): number {
    return this.settings.latencyWarnMs;
  }
}

/* ------------------------------ helpers --------------------------- */

/** A trailing slash changes the SDK's computed paths; strip it once, here. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

/**
 * `auth` failing means offline; a warning anywhere means degraded. A capability
 * probe coming back `warn` is not degradation — the server works, it just lacks a
 * feature — so only the connectivity checks decide.
 */
const CONNECTIVITY_CHECKS = new Set(['dns', 'tcp', 'tls', 'auth', 'listBuckets']);

export function statusFromChecks(result: TestServerResponse): 'healthy' | 'degraded' | 'offline' {
  const connectivity = result.checks.filter((check) => CONNECTIVITY_CHECKS.has(check.id));
  if (connectivity.some((check) => check.status === 'fail')) return 'offline';
  if (connectivity.some((check) => check.status === 'warn')) return 'degraded';
  return 'healthy';
}

/** The `auth` check's duration: one signed round trip to the server. */
export function latencyFromChecks(result: TestServerResponse): number | null {
  const auth = result.checks.find((check) => check.id === 'auth');
  if (auth === undefined || auth.status === 'skipped') return null;
  return auth.durationMs;
}

export function firstFailureDetail(result: TestServerResponse): string | null {
  const failed = result.checks.find(
    (check) =>
      CONNECTIVITY_CHECKS.has(check.id) && check.status !== 'ok' && check.status !== 'skipped',
  );
  if (failed === undefined) return null;
  return `${failed.label}: ${failed.detail ?? failed.status}`;
}
