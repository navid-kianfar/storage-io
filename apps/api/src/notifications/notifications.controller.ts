import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  listNotificationsQuerySchema,
  markNotificationsReadRequestSchema,
  type NotificationList,
} from '@storage-io/contracts';
import { dtoFrom } from '../common/dto';
import { LogActivity } from '../activity/activity.interceptor';
import { NotificationsService } from './notifications.service';

class ListNotificationsQueryDto extends dtoFrom(listNotificationsQuerySchema) {}
class MarkReadDto extends dtoFrom(markNotificationsReadRequestSchema) {}

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List notifications, newest first' })
  list(@Query() query: ListNotificationsQueryDto): NotificationList {
    return this.notifications.list(query.unread === true);
  }

  @Post('read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({
    category: 'system',
    action: 'notification.read',
    title: 'Marked notifications read',
  })
  @ApiOperation({ summary: 'Mark notifications read' })
  markRead(@Body() body: MarkReadDto): void {
    this.notifications.markRead(body.ids);
  }
}
