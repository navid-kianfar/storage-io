import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  testNotificationRequestSchema,
  updateSettingsRequestSchema,
  type Settings,
  type TestNotificationResponse,
} from '@storage-io/contracts';
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
