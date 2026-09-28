import { Module } from '@nestjs/common';
import { ServersModule } from '../../servers/servers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { QuotaRepository } from './quota.repository';
import { QuotaWatcherService } from './quota-watcher.service';
import { QuotasController } from './quotas.controller';
import { QuotasService } from './quotas.service';

/**
 * `GET /quotas` and the threshold watcher. `QuotaRepository` is exported because
 * `PUT /servers/:sid/buckets/:bucket/quota` lives in the buckets module — the
 * quota is edited per bucket and only *listed* here.
 */
@Module({
  imports: [InventoryModule, ServersModule],
  controllers: [QuotasController],
  providers: [QuotaRepository, QuotasService, QuotaWatcherService],
  exports: [QuotaRepository, QuotasService],
})
export class QuotasModule {}
