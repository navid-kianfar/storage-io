import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ServersModule } from '../servers/servers.module';
import { InventoryModule } from '../modules/inventory/inventory.module';
import { JobsModule } from '../modules/jobs/jobs.module';
import { RetentionService } from './retention.service';

/** Scheduled housekeeping. No controllers: nothing here is requested. */
@Module({
  imports: [AuthModule, ServersModule, InventoryModule, JobsModule],
  providers: [RetentionService],
})
export class MaintenanceModule {}
