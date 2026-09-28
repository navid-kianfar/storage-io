import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ServersModule } from '../servers/servers.module';
import { RetentionService } from './retention.service';

/** Scheduled housekeeping. No controllers: nothing here is requested. */
@Module({
  imports: [AuthModule, ServersModule],
  providers: [RetentionService],
})
export class MaintenanceModule {}
