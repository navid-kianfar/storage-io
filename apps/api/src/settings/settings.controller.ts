import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  NOTIFICATION_CHANNELS,
  notificationChannelSchema,
  testNotificationRequestSchema,
  updateSettingsRequestSchema,
  type NotificationChannel,
  type Settings,
  type TestNotificationResponse,
} from '@storage-io/contracts';
import { ValidationError } from '../common/errors/domain.exception';
import { dtoFrom } from '../common/dto';
import { LogActivity } from '../activity/activity.interceptor';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from './settings.service';

class UpdateSettingsDto extends dtoFrom(updateSettingsRequestSchema) {}
class TestNotificationDto extends dtoFrom(testNotificationRequestSchema) {}

/**
 * `POST /settings/export` and `POST /settings/import` are deliberately absent:
 * they need the config-archive format, which belongs with the module that owns
 * server credentials. A later task adds them here.
 */
@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The full settings document, secrets removed' })
  get(): Settings {
    return this.settings.getPublic();
  }

  @Patch()
  @LogActivity({ category: 'system', action: 'settings.update', title: 'Updated settings' })
  @ApiOperation({ summary: 'Patch one or more settings sections' })
  update(@Body() body: UpdateSettingsDto): Settings {
    return this.settings.update(body);
  }

  @Delete('notifications/:channel')
  @LogActivity({
    category: 'system',
    action: 'settings.notifications.remove',
    title: 'Disconnected a notification channel',
  })
  @ApiParam({ name: 'channel', enum: NOTIFICATION_CHANNELS })
  @ApiOperation({
    summary: 'Disconnect one channel: clears its configuration, secret and rules',
  })
  removeChannel(@Param('channel') channel: string): Settings {
    const parsed = notificationChannelSchema.safeParse(channel);
    if (!parsed.success) {
      const known = NOTIFICATION_CHANNELS.join(', ');
      throw new ValidationError(`Unknown notification channel. Expected one of: ${known}.`);
    }
    const target: NotificationChannel = parsed.data;
    return this.settings.removeNotificationChannel(target);
  }

  @Post('notifications/test')
  @LogActivity({
    category: 'system',
    action: 'settings.notifications.test',
    title: 'Tested a notification channel',
  })
  @ApiOperation({ summary: 'Send a test message on one channel' })
  async testChannel(@Body() body: TestNotificationDto): Promise<TestNotificationResponse> {
    const result = await this.notifications.test(body.channel);
    return { ok: result.ok, detail: result.detail };
  }
}
