import type { S3Client } from '@aws-sdk/client-s3';
import type {
  Capability,
  CapabilityMap,
  CheckResult,
  IamDriver,
  Provider,
  ServerDrive,
  ServerNode,
  ServerOptions,
} from '@storage-io/contracts';

/**
 * The provider abstraction. A driver answers three questions about one storage
 * server: what it can do, how to talk S3 to it, and — where the provider has an
 * admin API — what it looks like inside.
 *
 * ## Extending this
 *
 * A new provider is a `ProviderProfile` plus, if it has an admin API, one
 * sub-driver. It is registered in `ProviderRegistryService` and nothing else
 * changes: the servers module, the connection tester and the health checker all
 * work through these interfaces.
 *
 * The sub-drivers are optional on purpose. `capabilities` is what tells the UI a
 * feature is missing, so a driver never has to stub a method it cannot implement
 * — an absent sub-driver and a `not_supported` capability say the same thing in
 * two places that are checked at different times.
 */

/**
 * A server plus its decrypted credentials. Built per operation and never
 * stored: the secret exists in memory for the length of a call.
 */
export interface ServerConnection {
  readonly id: string;
  readonly name: string;
  readonly provider: Provider;
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Garage's admin bearer token; null for every other provider. */
  readonly adminToken: string | null;
  readonly options: ServerOptions;
}

/** What an admin API can tell us about the deployment. */
export interface ProviderServerInfo {
  readonly version: string | null;
  readonly nodes: readonly ServerNode[];
  /** Totals across the deployment, when the admin API reports them. */
  readonly capacity: { readonly usedBytes: number | null; readonly totalBytes: number | null };
  readonly bucketCount: number | null;
  readonly objectCount: number | null;
}

export interface ProviderUsage {
  readonly usedBytes: number | null;
  readonly objectCount: number | null;
  readonly bucketCount: number | null;
  /** Per-bucket totals when the provider reports them in one call. */
  readonly buckets: readonly {
    readonly name: string;
    readonly sizeBytes: number | null;
    readonly objects: number | null;
  }[];
}

/**
 * IAM operations. Declared in full so the later IAM task implements against a
 * settled shape; only `minio-admin`'s server-info half is implemented today, and
 * the rest of this interface is what that task fills in per driver.
 */
export interface IamSubDriver {
  readonly kind: IamDriver;

  /** Reachability probe for the connection test — cheap, read-only. */
  ping(connection: ServerConnection): Promise<void>;

  listUsers?(connection: ServerConnection): Promise<readonly RawIamUser[]>;
  countUsers?(connection: ServerConnection): Promise<number>;
}

export interface RawIamUser {
  readonly name: string;
  readonly status: 'enabled' | 'disabled' | 'unknown';
  readonly policies: readonly string[];
  readonly memberOf: readonly string[];
}

/** Native bucket quotas, where the provider has them. */
export interface QuotaSubDriver {
  getBucketQuota(connection: ServerConnection, bucket: string): Promise<number | null>;
  setBucketQuota(
    connection: ServerConnection,
    bucket: string,
    limitBytes: number | null,
  ): Promise<void>;
}

/** Native usage statistics, avoiding an inventory scan. */
export interface UsageSubDriver {
  getUsage(connection: ServerConnection): Promise<ProviderUsage>;
}

/** Nodes and drives, for the server overview. */
export interface NodesSubDriver {
  listNodes(connection: ServerConnection): Promise<readonly ServerNode[]>;
  listDrives(connection: ServerConnection, node: string): Promise<readonly ServerDrive[]>;
}

export interface ProviderDriver {
  readonly provider: Provider;

  /**
   * What this provider supports before any probing: the honest starting point,
   * refined by `detectCapabilities`. `not_configured` means "possible, but this
   * server has not been given the endpoint or token it needs".
   */
  readonly baseCapabilities: CapabilityMap;

  /** An S3 client honouring path-style, TLS verification and a custom CA. */
  createS3Client(connection: ServerConnection): S3Client;

  /**
   * Refines `baseCapabilities` by asking the server. Must not throw: a probe
   * that fails leaves its capability at the base value and reports through the
   * returned map, because a capability probe is not a reason to fail a request.
   */
  detectCapabilities(
    connection: ServerConnection,
    context: CapabilityProbeContext,
  ): Promise<CapabilityMap>;

  /** Extra checks for the connection test, beyond the S3 ones everybody shares. */
  additionalChecks?(connection: ServerConnection): Promise<readonly CheckResult[]>;

  serverInfo?(connection: ServerConnection): Promise<ProviderServerInfo>;

  readonly iam?: IamSubDriver;
  readonly quota?: QuotaSubDriver;
  readonly usage?: UsageSubDriver;
  readonly nodes?: NodesSubDriver;
}

/**
 * What the shared S3 probing already discovered, so a driver does not repeat a
 * call the tester has made.
 */
export interface CapabilityProbeContext {
  readonly client: S3Client;
  /** A bucket to probe against, when the server has one. */
  readonly probeBucket: string | null;
}

/** A capability map builder, so a profile reads as a table rather than a loop. */
export const capabilityMap = (
  overrides: Partial<Record<Capability, CapabilityMap[Capability]>>,
  fallback: CapabilityMap[Capability] = 'not_supported',
): CapabilityMap => {
  const base: Record<string, CapabilityMap[Capability]> = {};
  for (const name of CAPABILITY_NAMES) base[name] = overrides[name] ?? fallback;
  return base as CapabilityMap;
};

/** Kept local so this module does not import the whole contracts index eagerly. */
const CAPABILITY_NAMES: readonly Capability[] = [
  'objects',
  'versioning',
  'objectLock',
  'lifecycle',
  'cors',
  'bucketPolicy',
  'tagging',
  'replication',
  'notifications',
  'encryption',
  'storageClasses',
  'iamUsers',
  'iamGroups',
  'iamPolicies',
  'accessKeys',
  'accessKeyExpiry',
  'bucketQuota',
  'usageStats',
  'nodes',
];
