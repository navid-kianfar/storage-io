import { Global, Module } from '@nestjs/common';
import { ActivityController } from './activity.controller';
import { ActivityInterceptor } from './activity.interceptor';
import { ActivityService } from './activity.service';
import { ActivitySyslogService } from './activity-syslog.service';

/**
 * Global: the interceptor is registered app-wide and every feature module
 * records system events, so exporting the service once beats importing it
 * everywhere.
 */
@Global()
@Module({
  controllers: [ActivityController],
  providers: [ActivityService, ActivityInterceptor, ActivitySyslogService],
  exports: [ActivityService, ActivityInterceptor, ActivitySyslogService],
})
export class ActivityModule {}
