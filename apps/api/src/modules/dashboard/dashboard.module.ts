import { Module } from '@nestjs/common';
import { ServersModule } from '../../servers/servers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { IamCoreModule } from '../iam-core/iam-core.module';
import { JobsModule } from '../jobs/jobs.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * `GET /dashboard`. It reads from four other modules' repositories and owns no
 * table of its own, which is why it is last in `AppModule`'s import list: every
 * source it aggregates has to exist first.
 */
@Module({
  imports: [ServersModule, InventoryModule, IamCoreModule, JobsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
