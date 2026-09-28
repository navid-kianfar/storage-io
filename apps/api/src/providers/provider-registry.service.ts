import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import { PROVIDERS, type Capability, type Provider } from '@storage-io/contracts';
import { NotSupportedError } from '../common/errors/domain.exception';
import { S3ClientFactory } from './s3/s3-client.factory';
import { S3ProbeService } from './s3/s3-probe.service';
import { S3GenericDriver } from './drivers/s3-generic.driver';
import { MinioAdminClient } from './minio/minio-admin.client';
import { MinioDriver } from './minio/minio.driver';
import { MinioMetricsClient } from './minio/minio-metrics.client';
import { AdminHttpClient } from './iam/admin-http.client';
import { AwsIamDriver } from './iam/aws-iam.driver';
import { CephIamDriver } from './iam/ceph-iam.driver';
import { GarageIamDriver } from './iam/garage-iam.driver';
import { IamCapableS3Driver } from './iam/iam-capable.driver';
import type {
  IamSubDriver,
  NodesSubDriver,
  ProviderDriver,
  QuotaSubDriver,
  ServerConnection,
  TrafficSubDriver,
  UsageSubDriver,
} from './provider-driver';
import type {
  IamAccessKeyOperations,
  IamGroupOperations,
  IamPolicyOperations,
  IamUserOperations,
} from './iam/iam-driver';

/**
 * Maps a provider type to its driver.
 *
 * Providers with only S3 features share `S3GenericDriver`, constructed per
 * provider so each carries its own capability profile. Providers with an admin
 * API get their own class.
 *
 * **Adding a provider driver**
 *
 * 1. Add its capability profile to `provider-profiles.ts`.
 * 2. Write the driver — extend `S3GenericDriver` and add the sub-drivers the
 *    provider supports (`iam`, `quota`, `usage`, `nodes`).
 * 3. Register it in `buildDrivers` below.
 * 4. Nothing else changes: the servers module, connection tester and health
 *    checker all work through `ProviderDriver`.
 *
 * The remaining admin drivers (`aws-iam`, `ceph-admin`, `garage-admin`) are a
 * later task; those providers currently run on `S3GenericDriver`, which is why
 * their profiles report the admin-only capabilities as `not_configured`.
 */
@Injectable()
export class ProviderRegistryService implements OnApplicationShutdown {
  private readonly logger = new Logger(ProviderRegistryService.name);
  private readonly drivers: ReadonlyMap<Provider, ProviderDriver>;

  constructor(
    private readonly clients: S3ClientFactory,
    private readonly probes: S3ProbeService,
    private readonly minioAdmin: MinioAdminClient,
    private readonly minioMetrics: MinioMetricsClient,
    private readonly adminHttp: AdminHttpClient,
    private readonly awsIam: AwsIamDriver,
    private readonly cephIam: CephIamDriver,
    private readonly garageIam: GarageIamDriver,
  ) {
    this.drivers = this.buildDrivers();
    this.logger.log(`Registered ${this.drivers.size} provider driver(s)`);
  }

  private buildDrivers(): ReadonlyMap<Provider, ProviderDriver> {
    const drivers = new Map<Provider, ProviderDriver>();
    drivers.set(
      'minio',
      new MinioDriver(this.clients, this.probes, this.minioAdmin, this.minioMetrics),
    );

    // The IAM-only admin surfaces. Each is S3 core plus one IAM sub-driver; what
    // the provider can actually do is its capability profile's business, not this
    // loop's — a reachable endpoint never promotes a `not_supported`.
    for (const [provider, label] of IAM_ONLY_PROVIDERS) {
      drivers.set(provider, this.iamCapable(provider, this.iamDriverFor(provider), label));
    }

    for (const provider of PROVIDERS) {
      if (drivers.has(provider)) continue;
      drivers.set(provider, new S3GenericDriver(provider, this.clients, this.probes));
    }
    return drivers;
  }

  private iamCapable(provider: Provider, iam: IamSubDriver, label: string): ProviderDriver {
    return new IamCapableS3Driver(provider, this.clients, this.probes, iam, label);
  }

  /**
   * Matched exhaustively rather than with a default: a provider added to the
   * contract should fail to compile here, not quietly inherit the AWS driver.
   * `minio` has its own class and the rest have no IAM surface at all, so both are
   * named and refused.
   */
  private iamDriverFor(provider: Provider): IamSubDriver {
    switch (provider) {
      case 'seaweedfs':
      case 'aws':
      case 'wasabi':
        return this.awsIam;
      case 'ceph':
        return this.cephIam;
      case 'garage':
        return this.garageIam;
      case 'minio':
      case 'r2':
      case 'generic':
        throw new NotSupportedError(`${provider} has no IAM-only driver in storage-io.`);
    }
  }

  driverFor(provider: Provider): ProviderDriver {
    const driver = this.drivers.get(provider);
    if (driver === undefined) {
      // Unreachable while the map is built from PROVIDERS, but a new provider in
      // the contract with no driver here must fail loudly rather than silently.
      throw new NotSupportedError(`No driver is registered for provider "${provider}".`);
    }
    return driver;
  }

  /** A client that bypasses the cache — for testing unsaved connection details. */
  transientClient(connection: ServerConnection): S3Client {
    return this.clients.createTransient(connection);
  }

  /**
   * Fetches a sub-driver or fails with `NOT_SUPPORTED`. Every caller needs the
   * same check, and one place to raise it keeps the message consistent.
   */
  iamFor(connection: ServerConnection): IamSubDriver {
    return this.require(connection, 'iam', 'iamUsers');
  }

  usageFor(connection: ServerConnection): UsageSubDriver {
    return this.require(connection, 'usage', 'usageStats');
  }

  quotaFor(connection: ServerConnection): QuotaSubDriver {
    return this.require(connection, 'quota', 'bucketQuota');
  }

  /**
   * Whether a native quota is available at all. The buckets module asks before
   * deciding between a native quota and an alert-only one, and a missing
   * sub-driver is a normal answer there rather than an error.
   */
  hasNativeQuota(connection: ServerConnection): boolean {
    return this.driverFor(connection.provider).quota !== undefined;
  }

  nodesFor(connection: ServerConnection): NodesSubDriver {
    return this.require(connection, 'nodes', 'nodes');
  }

  /**
   * The traffic sub-driver, or `null` for a provider with no metrics endpoint.
   * Null rather than a throw: the sampler walks every server and a provider
   * without one is the normal case, not an error.
   */
  trafficIfAny(connection: ServerConnection): TrafficSubDriver | null {
    return this.driverFor(connection.provider).traffic ?? null;
  }

  private require<TKey extends 'iam' | 'usage' | 'nodes' | 'quota'>(
    connection: ServerConnection,
    key: TKey,
    capability: Capability,
  ): NonNullable<ProviderDriver[TKey]> {
    const driver = this.driverFor(connection.provider);
    const sub = driver[key];
    if (sub === undefined) {
      throw new NotSupportedError(
        `${connection.provider} does not support ${capability} in storage-io.`,
      );
    }
    return sub;
  }

  /**
   * The four IAM operation groups, or a consistent `NOT_SUPPORTED`. Every IAM
   * service calls one of these rather than reaching for `driver.iam?.users`, so
   * the message an operator sees is the same wherever the gap is.
   */
  iamUsersFor(connection: ServerConnection): IamUserOperations {
    return this.requireIamGroup(connection, 'users', 'iamUsers');
  }

  iamGroupsFor(connection: ServerConnection): IamGroupOperations {
    return this.requireIamGroup(connection, 'groups', 'iamGroups');
  }

  iamPoliciesFor(connection: ServerConnection): IamPolicyOperations {
    return this.requireIamGroup(connection, 'policies', 'iamPolicies');
  }

  iamKeysFor(connection: ServerConnection): IamAccessKeyOperations {
    return this.requireIamGroup(connection, 'keys', 'accessKeys');
  }

  /**
   * Groups when the provider has them, `null` when it does not — for the places
   * where their absence is not an error, such as showing which of a user's
   * policies came from a group.
   */
  iamGroupsIfAny(connection: ServerConnection): IamGroupOperations | null {
    const driver = this.driverFor(connection.provider);
    return driver.iam?.groups ?? null;
  }

  private requireIamGroup<TKey extends 'users' | 'groups' | 'policies' | 'keys'>(
    connection: ServerConnection,
    key: TKey,
    capability: Capability,
  ): NonNullable<IamSubDriver[TKey]> {
    const iam = this.iamFor(connection);
    const group = iam[key];
    if (group === undefined) {
      throw new NotSupportedError(
        `${connection.provider} does not support ${capability} in storage-io.`,
      );
    }
    return group;
  }

  /** Called when a server is removed or its connection details change. */
  evict(serverId: string): void {
    this.clients.evict(serverId);
    this.minioAdmin.evict(serverId);
    this.awsIam.evict(serverId);
    this.adminHttp.evict(serverId);
  }

  onApplicationShutdown(): void {
    this.clients.evictAll();
    this.minioAdmin.evictAll();
    this.awsIam.evictAll();
    this.adminHttp.evictAll();
    this.logger.log('Provider clients released');
  }
}

/**
 * The providers whose only admin surface is IAM, with the label their connection
 * test row carries. MinIO is absent because its admin API also answers nodes,
 * usage and quotas, so it has a driver of its own.
 */
const IAM_ONLY_PROVIDERS: readonly (readonly [Provider, string])[] = [
  ['seaweedfs', 'SeaweedFS IAM API'],
  ['aws', 'AWS IAM'],
  ['wasabi', 'Wasabi IAM API'],
  ['ceph', 'Ceph RGW admin API'],
  ['garage', 'Garage admin API'],
] as const;
