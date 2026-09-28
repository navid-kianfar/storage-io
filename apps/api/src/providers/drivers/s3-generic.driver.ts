import { Injectable } from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import type { CapabilityMap, Provider } from '@storage-io/contracts';
import { S3ClientFactory } from '../s3/s3-client.factory';
import { S3ProbeService } from '../s3/s3-probe.service';
import { PROVIDER_CAPABILITY_PROFILES } from '../provider-profiles';
import type { CapabilityProbeContext, ProviderDriver, ServerConnection } from '../provider-driver';

/**
 * The driver every provider without an admin API uses, and the base the MinIO
 * driver extends. It does what S3 alone can: talk to buckets and objects, and
 * settle the three capabilities that can be probed over S3 (versioning, object
 * lock, replication).
 *
 * One instance serves several provider types — they differ only in their
 * capability profile — so the registry constructs it per provider.
 */
@Injectable()
export class S3GenericDriver implements ProviderDriver {
  constructor(
    readonly provider: Provider,
    protected readonly clients: S3ClientFactory,
    protected readonly probes: S3ProbeService,
  ) {}

  get baseCapabilities(): CapabilityMap {
    return PROVIDER_CAPABILITY_PROFILES[this.provider];
  }

  createS3Client(connection: ServerConnection): S3Client {
    return this.clients.create(connection);
  }

  /**
   * Only the three S3-probeable capabilities are touched; everything else keeps
   * its profile value. A probe that cannot reach a bucket leaves the capability
   * alone rather than downgrading it on no evidence.
   */
  async detectCapabilities(
    _connection: ServerConnection,
    context: CapabilityProbeContext,
  ): Promise<CapabilityMap> {
    const detected: CapabilityMap = { ...this.baseCapabilities };
    const bucket = context.probeBucket;
    if (bucket === null) return detected;

    const [versioning, objectLock, replication] = await Promise.all([
      this.probes.probeVersioning(context.client, bucket),
      this.probes.probeObjectLock(context.client, bucket),
      this.probes.probeReplication(context.client, bucket),
    ]);

    return {
      ...detected,
      versioning: keepBetter(detected.versioning, versioning.state),
      objectLock: keepBetter(detected.objectLock, objectLock.state),
      replication: keepBetter(detected.replication, replication.state),
    };
  }
}

/**
 * A probe may only ever *confirm* or *deny*, never weaken a known yes to a
 * maybe: `not_configured` from an inconclusive probe must not overwrite a
 * profile's `supported`.
 */
function keepBetter(
  profile: CapabilityMap[keyof CapabilityMap],
  probed: CapabilityMap[keyof CapabilityMap],
): CapabilityMap[keyof CapabilityMap] {
  if (probed === 'supported') return 'supported';
  if (probed === 'not_supported') return 'not_supported';
  return profile;
}
