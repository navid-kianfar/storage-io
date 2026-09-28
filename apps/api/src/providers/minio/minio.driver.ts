import { Injectable, Logger } from '@nestjs/common';
import type {
  CapabilityMap,
  CheckResult,
  ServerDrive,
  ServerNode,
  DriveState,
  NodeState,
} from '@storage-io/contracts';
import { NotFoundError } from '../../common/errors/domain.exception';
import { S3ClientFactory } from '../s3/s3-client.factory';
import { S3ProbeService } from '../s3/s3-probe.service';
import { S3GenericDriver } from '../drivers/s3-generic.driver';
import type {
  CapabilityProbeContext,
  IamSubDriver,
  NodesSubDriver,
  ProviderServerInfo,
  ProviderUsage,
  RawIamUser,
  ServerConnection,
  UsageSubDriver,
} from '../provider-driver';
import { MinioAdminClient } from './minio-admin.client';

/* --------------------- Admin API response shapes ------------------ *
 * Only the fields storage-io uses. `GET /minio/admin/v3/info` also returns
 * `minio_env_vars`, which contains MINIO_ROOT_PASSWORD — nothing from that
 * response is passed through unmapped, which is why these are narrow.
 * ------------------------------------------------------------------ */

interface AdminDrive {
  readonly endpoint?: string;
  readonly path?: string;
  readonly state?: string;
  readonly totalspace?: number;
  readonly usedspace?: number;
  readonly availspace?: number;
  readonly model?: string;
  readonly healing?: boolean;
}

interface AdminServer {
  readonly state?: string;
  readonly endpoint?: string;
  readonly uptime?: number;
  readonly version?: string;
  readonly drives?: readonly AdminDrive[];
}

interface AdminInfo {
  readonly mode?: string;
  readonly buckets?: { readonly count?: number };
  readonly objects?: { readonly count?: number };
  readonly usage?: { readonly size?: number };
  readonly servers?: readonly AdminServer[];
}

interface AdminUser {
  readonly status?: string;
  readonly policyName?: string;
  readonly memberOf?: readonly string[];
}

interface AdminDataUsage {
  readonly objectsCount?: number;
  readonly objectsTotalSize?: number;
  readonly bucketsCount?: number;
  readonly bucketsUsage?: Readonly<
    Record<string, { readonly size?: number; readonly objectsCount?: number }>
  >;
}

/**
 * MinIO: S3 core plus the Admin API v3, which is what makes version, nodes,
 * drives, native quotas and real usage numbers possible.
 *
 * It extends the generic S3 driver rather than reimplementing it, so a fix to
 * the shared probing reaches MinIO too.
 */
@Injectable()
export class MinioDriver extends S3GenericDriver {
  private readonly log = new Logger(MinioDriver.name);

  readonly iam: IamSubDriver;
  readonly usage: UsageSubDriver;
  readonly nodes: NodesSubDriver;

  constructor(
    clients: S3ClientFactory,
    probes: S3ProbeService,
    private readonly admin: MinioAdminClient,
  ) {
    super('minio', clients, probes);

    this.iam = {
      kind: 'minio-admin',
      ping: async (connection) => {
        await this.admin.json<AdminInfo>(connection, '/info');
      },
      listUsers: async (connection) => this.listUsers(connection),
      countUsers: async (connection) => (await this.listUsers(connection)).length,
    };

    this.usage = { getUsage: async (connection) => this.getUsage(connection) };

    this.nodes = {
      listNodes: async (connection) => (await this.serverInfo(connection)).nodes,
      listDrives: async (connection, node) => this.listDrives(connection, node),
    };
  }

  /**
   * The admin API settles what S3 probing cannot: whether the admin surface is
   * reachable at all, and therefore whether the IAM, quota, usage and node
   * features are really available on this server.
   */
  override async detectCapabilities(
    connection: ServerConnection,
    context: CapabilityProbeContext,
  ): Promise<CapabilityMap> {
    const fromS3 = await super.detectCapabilities(connection, context);

    try {
      const info = await this.admin.json<AdminInfo>(connection, '/info');
      const hasNodes = (info.servers ?? []).length > 0;
      return {
        ...fromS3,
        iamUsers: 'supported',
        iamGroups: 'supported',
        iamPolicies: 'supported',
        accessKeys: 'supported',
        accessKeyExpiry: 'supported',
        bucketQuota: 'supported',
        usageStats: 'supported',
        nodes: hasNodes ? 'supported' : 'not_configured',
      };
    } catch (error) {
      // A reachable S3 endpoint with an unreachable admin API is a normal
      // deployment: a restricted key. Everything admin-only becomes
      // not_configured rather than not_supported, because MinIO *can* do it.
      this.log.debug(
        { server: connection.name, err: errorMessage(error) },
        'MinIO admin API not reachable; admin capabilities reported not_configured',
      );
      return {
        ...fromS3,
        iamUsers: 'not_configured',
        iamGroups: 'not_configured',
        iamPolicies: 'not_configured',
        accessKeys: 'not_configured',
        accessKeyExpiry: 'not_configured',
        bucketQuota: 'not_configured',
        usageStats: 'not_configured',
        nodes: 'not_configured',
      };
    }
  }

  /** The admin-API reachability check, added to the shared connection test. */
  async additionalChecks(connection: ServerConnection): Promise<readonly CheckResult[]> {
    const started = Date.now();
    try {
      const info = await this.admin.json<AdminInfo>(connection, '/info');
      const nodeCount = (info.servers ?? []).length;
      return [
        {
          id: 'admin',
          label: 'MinIO admin API',
          status: 'ok',
          detail: `${info.mode ?? 'unknown'} · ${nodeCount} node(s) · ${versionOf(info) ?? 'unknown version'}`,
          durationMs: Date.now() - started,
        },
      ];
    } catch (error) {
      return [
        {
          id: 'admin',
          label: 'MinIO admin API',
          // A warning, not a failure: S3 still works, only the admin features
          // are unavailable.
          status: 'warn',
          detail: errorMessage(error),
          durationMs: Date.now() - started,
        },
      ];
    }
  }

  async serverInfo(connection: ServerConnection): Promise<ProviderServerInfo> {
    const info = await this.admin.json<AdminInfo>(connection, '/info');
    const servers = info.servers ?? [];

    const nodes = servers.map((server): ServerNode => {
      const drives = server.drives ?? [];
      const online = drives.filter((drive) => drive.state === 'ok').length;
      return {
        name: server.endpoint ?? 'unknown',
        endpoint: server.endpoint ?? 'unknown',
        state: nodeStateOf(server.state, online, drives.length),
        drivesOnline: online,
        drivesTotal: drives.length,
        uptimeSec: typeof server.uptime === 'number' ? Math.trunc(server.uptime) : null,
        // MinIO's info payload has no per-node CPU or memory percentage; it
        // reports Go runtime allocation, which is not the same thing and would
        // mislead the gauge, so both stay null.
        cpu: null,
        mem: null,
        usedBytes: sumOf(drives, (drive) => drive.usedspace),
        totalBytes: sumOf(drives, (drive) => drive.totalspace),
      };
    });

    const capacityUsed = sumOf(nodes, (node) => node.usedBytes ?? undefined);
    const capacityTotal = sumOf(nodes, (node) => node.totalBytes ?? undefined);

    return {
      version: versionOf(info),
      nodes,
      capacity: {
        // `usage.size` is object bytes; drive usage is what the capacity gauge
        // means, so prefer it and fall back to the object total.
        usedBytes: capacityUsed ?? info.usage?.size ?? null,
        totalBytes: capacityTotal,
      },
      bucketCount: info.buckets?.count ?? null,
      objectCount: info.objects?.count ?? null,
    };
  }

  private async listDrives(
    connection: ServerConnection,
    node: string,
  ): Promise<readonly ServerDrive[]> {
    const info = await this.admin.json<AdminInfo>(connection, '/info');
    const server = (info.servers ?? []).find((candidate) => candidate.endpoint === node);
    if (server === undefined) throw new NotFoundError(`No node named "${node}" on this server.`);

    return (server.drives ?? []).map((drive): ServerDrive => ({
      path: drive.path ?? drive.endpoint ?? 'unknown',
      state: driveStateOf(drive.state),
      usedBytes: drive.usedspace ?? null,
      totalBytes: drive.totalspace ?? null,
      model: drive.model ?? null,
      healing: drive.healing === true || drive.state === 'healing',
    }));
  }

  private async listUsers(connection: ServerConnection): Promise<readonly RawIamUser[]> {
    // The response is a madmin envelope; the client decrypts it transparently.
    const users = await this.admin.json<Record<string, AdminUser>>(connection, '/list-users');
    return Object.entries(users).map(([name, user]): RawIamUser => ({
      name,
      status:
        user.status === 'enabled' ? 'enabled' : user.status === 'disabled' ? 'disabled' : 'unknown',
      policies: splitPolicies(user.policyName),
      memberOf: user.memberOf ?? [],
    }));
  }

  private async getUsage(connection: ServerConnection): Promise<ProviderUsage> {
    const usage = await this.admin.json<AdminDataUsage>(connection, '/datausageinfo');
    const buckets = Object.entries(usage.bucketsUsage ?? {}).map(([name, bucket]) => ({
      name,
      sizeBytes: bucket.size ?? null,
      objects: bucket.objectsCount ?? null,
    }));

    return {
      usedBytes: usage.objectsTotalSize ?? null,
      objectCount: usage.objectsCount ?? null,
      bucketCount: usage.bucketsCount ?? buckets.length,
      buckets,
    };
  }
}

/* ------------------------------ helpers --------------------------- */

/** MinIO reports the version per node, not at the top level. */
function versionOf(info: AdminInfo): string | null {
  return (info.servers ?? [])[0]?.version ?? null;
}

function nodeStateOf(
  state: string | undefined,
  drivesOnline: number,
  drivesTotal: number,
): NodeState {
  if (state !== 'online') return 'offline';
  if (drivesTotal > 0 && drivesOnline < drivesTotal) return 'degraded';
  return 'online';
}

function driveStateOf(state: string | undefined): DriveState {
  switch (state) {
    case 'ok':
      return 'ok';
    case 'offline':
    case 'unavailable':
      return 'offline';
    case 'healing':
      return 'healing';
    case 'unformatted':
      return 'unformatted';
    case undefined:
    default:
      return 'unknown';
  }
}

/** `null` when no entry reported a number — "unknown", not "zero". */
function sumOf<T>(items: readonly T[], pick: (item: T) => number | undefined): number | null {
  let total = 0;
  let sawOne = false;
  for (const item of items) {
    const value = pick(item);
    if (typeof value !== 'number') continue;
    total += value;
    sawOne = true;
  }
  return sawOne ? total : null;
}

/** MinIO joins several attached policies with commas in one field. */
function splitPolicies(policyName: string | undefined): readonly string[] {
  if (policyName === undefined || policyName.length === 0) return [];
  return policyName
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
