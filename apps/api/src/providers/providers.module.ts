import { Module } from '@nestjs/common';
import { ConnectionTesterService } from './connection-tester.service';
import { ProviderRegistryService } from './provider-registry.service';
import { MinioAdminClient } from './minio/minio-admin.client';
import { S3ClientFactory } from './s3/s3-client.factory';
import { S3ProbeService } from './s3/s3-probe.service';

/**
 * The provider layer. It has no controllers: it is what the servers, buckets,
 * objects and IAM modules are built on.
 *
 * Every provider is a singleton — the S3 client factory and the admin client
 * hold keep-alive pools, and a request-scoped provider would open a fresh TCP
 * connection per call.
 */
@Module({
  providers: [
    S3ClientFactory,
    S3ProbeService,
    MinioAdminClient,
    ProviderRegistryService,
    ConnectionTesterService,
  ],
  exports: [
    S3ClientFactory,
    S3ProbeService,
    MinioAdminClient,
    ProviderRegistryService,
    ConnectionTesterService,
  ],
})
export class ProvidersModule {}
