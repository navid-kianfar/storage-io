import { Module } from '@nestjs/common';
import { ProvidersModule } from '../../providers/providers.module';
import { ServersModule } from '../../servers/servers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { JobsModule } from '../jobs/jobs.module';
import { ObjectsModule } from '../objects/objects.module';
import { QuotasModule } from '../quotas/quotas.module';
import { StorageModule } from '../storage/storage.module';
import { BucketDetailController } from './bucket-detail.controller';
import { BucketSettingsService } from './bucket-settings.service';
import { BucketsController } from './buckets.controller';
import { BucketsService } from './buckets.service';

/**
 * Buckets and every per-bucket setting.
 *
 * It sits on top of most of wave 2a: the inventory for the cached list,
 * `ObjectsModule` for the batched delete that force-delete needs, `QuotasModule`
 * for the quota table and `JobsModule` for `POST …/empty`. The dependency runs one
 * way — nothing below imports this module back.
 */
@Module({
  imports: [
    StorageModule,
    InventoryModule,
    QuotasModule,
    ObjectsModule,
    JobsModule,
    ProvidersModule,
    ServersModule,
  ],
  controllers: [BucketsController, BucketDetailController],
  providers: [BucketsService, BucketSettingsService],
  exports: [BucketsService, BucketSettingsService],
})
export class BucketsModule {}
