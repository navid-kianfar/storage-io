import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import { PROVIDERS, type Capability, type Provider } from '@storage-io/contracts';
import { NotSupportedError } from '../common/errors/domain.exception';
import { S3ClientFactory } from './s3/s3-client.factory';
import { S3ProbeService } from './s3/s3-probe.service';
import { S3GenericDriver } from './drivers/s3-generic.driver';
import { MinioAdminClient } from './minio/minio-admin.client';
import { MinioDriver } from './minio/minio.driver';
import type {
  IamSubDriver,
  NodesSubDriver,
  ProviderDriver,
  ServerConnection,
  UsageSubDriver,
} from './provider-driver';

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
  ) {
    this.drivers = this.buildDrivers();
    this.logger.log(`Registered ${this.drivers.size} provider driver(s)`);
  }

  private buildDrivers(): ReadonlyMap<Provider, ProviderDriver> {
    const drivers = new Map<Provider, ProviderDriver>();
    drivers.set('minio', new MinioDriver(this.clients, this.probes, this.minioAdmin));

    for (const provider of PROVIDERS) {
      if (drivers.has(provider)) continue;
      drivers.set(provider, new S3GenericDriver(provider, this.clients, this.probes));
    }
    return drivers;
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

  nodesFor(connection: ServerConnection): NodesSubDriver {
    return this.require(connection, 'nodes', 'nodes');
  }

  private require<TKey extends 'iam' | 'usage' | 'nodes'>(
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

  /** Called when a server is removed or its connection details change. */
  evict(serverId: string): void {
    this.clients.evict(serverId);
    this.minioAdmin.evict(serverId);
  }

  onApplicationShutdown(): void {
    this.clients.evictAll();
    this.minioAdmin.evictAll();
    this.logger.log('Provider clients released');
  }
}
