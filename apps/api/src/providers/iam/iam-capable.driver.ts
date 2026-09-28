import { Logger } from '@nestjs/common';
import type { CapabilityMap, CheckResult, Provider } from '@storage-io/contracts';
import { S3GenericDriver } from '../drivers/s3-generic.driver';
import type { S3ClientFactory } from '../s3/s3-client.factory';
import type { S3ProbeService } from '../s3/s3-probe.service';
import type { CapabilityProbeContext, IamSubDriver, ServerConnection } from '../provider-driver';
import { settleIamCapabilities } from './iam-driver';

/**
 * S3 core plus an IAM sub-driver, for the providers whose admin surface is only
 * IAM: SeaweedFS, AWS, Wasabi, Ceph RGW and Garage. MinIO has its own driver
 * because its admin API also answers nodes, usage and quotas.
 *
 * The one thing it adds over `S3GenericDriver` is honesty about the IAM
 * capabilities: the profile says what the provider can do, and one cheap `ping`
 * says whether this server has been given the endpoint and credentials it needs.
 * A probe never promotes a `not_supported` — a reachable IAM endpoint does not
 * give SeaweedFS groups.
 */
export class IamCapableS3Driver extends S3GenericDriver {
  private readonly log = new Logger(IamCapableS3Driver.name);

  constructor(
    provider: Provider,
    clients: S3ClientFactory,
    probes: S3ProbeService,
    readonly iam: IamSubDriver,
    /** What the connection test calls this row, e.g. "SeaweedFS IAM API". */
    private readonly adminLabel: string,
  ) {
    super(provider, clients, probes);
  }

  override async detectCapabilities(
    connection: ServerConnection,
    context: CapabilityProbeContext,
  ): Promise<CapabilityMap> {
    const fromS3 = await super.detectCapabilities(connection, context);
    const reachable = await this.pingQuietly(connection);
    return settleIamCapabilities(fromS3, reachable);
  }

  /** One extra row on the connection test: is the IAM endpoint usable? */
  async additionalChecks(connection: ServerConnection): Promise<readonly CheckResult[]> {
    const started = Date.now();
    try {
      await this.iam.ping(connection);
      return [
        {
          id: 'admin',
          label: this.adminLabel,
          status: 'ok',
          detail: 'Reachable',
          durationMs: Date.now() - started,
        },
      ];
    } catch (error) {
      return [
        {
          id: 'admin',
          label: this.adminLabel,
          // A warning, not a failure: S3 still works, only the IAM features are
          // unavailable — which is the normal state for a restricted key.
          status: 'warn',
          detail: messageOf(error),
          durationMs: Date.now() - started,
        },
      ];
    }
  }

  /**
   * `detectCapabilities` must not throw, so the probe swallows its error and
   * records it at debug level — an unreachable IAM endpoint is a configuration
   * fact, not a request failure.
   */
  private async pingQuietly(connection: ServerConnection): Promise<boolean> {
    try {
      await this.iam.ping(connection);
      return true;
    } catch (error) {
      this.log.debug(
        { server: connection.name, err: messageOf(error) },
        'IAM endpoint not reachable; IAM capabilities reported not_configured',
      );
      return false;
    }
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
