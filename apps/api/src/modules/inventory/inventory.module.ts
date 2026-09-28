import { Module } from '@nestjs/common';
import { ServersModule } from '../../servers/servers.module';
import { StorageModule } from '../storage/storage.module';
import { BucketFactsService } from './bucket-facts.service';
import { InventoryRefresherService } from './inventory-refresher.service';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';

/**
 * The bucket inventory cache and the sweep that fills it. No controllers: the
 * buckets and quotas modules are its readers, and `inventory.updated` on the SSE
 * stream is how the web app learns a pass finished.
 */
@Module({
  imports: [StorageModule, ServersModule],
  providers: [InventoryRepository, BucketFactsService, InventoryService, InventoryRefresherService],
  exports: [InventoryRepository, BucketFactsService, InventoryService, InventoryRefresherService],
})
export class InventoryModule {}
