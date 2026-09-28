import { Module } from '@nestjs/common';
import { ConnectionTesterService } from './connection-tester.service';
import { ProviderRegistryService } from './provider-registry.service';
import { MinioAdminClient } from './minio/minio-admin.client';
import { MinioMetricsClient } from './minio/minio-metrics.client';
import { AdminHttpClient } from './iam/admin-http.client';
import { AwsIamDriver } from './iam/aws-iam.driver';
import { CephIamDriver } from './iam/ceph-iam.driver';
import { GarageIamDriver } from './iam/garage-iam.driver';
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
    MinioMetricsClient,
    AdminHttpClient,
    AwsIamDriver,
    CephIamDriver,
    GarageIamDriver,
    ProviderRegistryService,
    ConnectionTesterService,
  ],
  exports: [
    S3ClientFactory,
    S3ProbeService,
    MinioAdminClient,
    MinioMetricsClient,
    AdminHttpClient,
    ProviderRegistryService,
    ConnectionTesterService,
  ],
})
export class ProvidersModule {}
