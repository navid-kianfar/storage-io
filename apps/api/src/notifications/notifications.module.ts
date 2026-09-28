import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannelDriver,
} from './delivery/notification-channel';
import { realChannels } from './delivery/channels';

/**
 * Global: the health checker, the quota watcher and the job engine all raise
 * notifications.
 *
 * The channel list is a custom provider, which is what let wave 2c replace the
 * placeholder drivers with `realChannels()` — SMTP, a signed webhook, the Telegram
 * Bot API and syslog — without a single consumer of `NotificationsService`
 * changing. `defaultChannels()` is still in `delivery/notification-channel.ts` for
 * a test that wants a channel that does nothing.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (): readonly NotificationChannelDriver[] => realChannels(),
    },
  ],
  exports: [NotificationsService, NOTIFICATION_CHANNELS],
})
export class NotificationsModule {}
