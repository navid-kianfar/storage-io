import { Global, Module } from '@nestjs/common';
import { EventBusService } from './event-bus.service';
import { EventsController } from './events.controller';

/**
 * Global: the health checker, the job engine and the notification service all
 * publish, and a single bus is the whole point.
 */
@Global()
@Module({
  controllers: [EventsController],
  providers: [EventBusService],
  exports: [EventBusService],
})
export class EventsModule {}
