import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import {
  NOTIFICATION_CHANNELS,
  defaultChannels,
  type NotificationChannelDriver,
} from './delivery/notification-channel';

/**
 * Global: the health checker, the quota watcher and the job engine all raise
 * notifications.
 *
 * The channel list is a custom provider so a later task adds a real transport by
 * replacing `defaultChannels()` — no consumer of `NotificationsService` changes.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (): readonly NotificationChannelDriver[] => defaultChannels(),
    },
  ],
  exports: [NotificationsService, NOTIFICATION_CHANNELS],
})
export class NotificationsModule {}
