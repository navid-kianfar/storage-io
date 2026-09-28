import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  listIamGroupsQuerySchema,
  upsertS3GroupRequestSchema,
  type S3Group,
  type S3GroupList,
} from '@storage-io/contracts';
import { dtoFrom } from '../../common/dto';
import { LogActivity } from '../../activity/activity.interceptor';
import { IamGroupsService } from './iam-groups.service';

class ListIamGroupsQueryDto extends dtoFrom(listIamGroupsQuerySchema) {}
class UpsertS3GroupDto extends dtoFrom(upsertS3GroupRequestSchema) {}

@ApiTags('iam-groups')
@Controller()
export class IamGroupsController {
  constructor(private readonly groups: IamGroupsService) {}

  @Get('iam/groups')
  @ApiOperation({ summary: 'S3 groups across every server that has them' })
  async list(@Query() query: ListIamGroupsQueryDto): Promise<S3GroupList> {
    return this.groups.list(query);
  }

  @Post('servers/:sid/iam/groups')
  @HttpCode(HttpStatus.CREATED)
  @LogActivity({
    category: 'access',
    action: 'iam-group.create',
    title: 'Created an S3 group',
    failureTitle: 'Failed to create an S3 group',
  })
  @ApiOperation({ summary: 'Create a group with its members and policies' })
  async create(@Param('sid') sid: string, @Body() body: UpsertS3GroupDto): Promise<S3Group> {
    return this.groups.create(sid, body);
  }

  @Patch('servers/:sid/iam/groups/:name')
  @LogActivity({
    category: 'access',
    action: 'iam-group.update',
    title: 'Edited an S3 group',
    failureTitle: 'Failed to edit an S3 group',
  })
  @ApiOperation({ summary: "Replace the group's members, policies and status" })
  async update(
    @Param('sid') sid: string,
    @Param('name') name: string,
    @Body() body: UpsertS3GroupDto,
  ): Promise<S3Group> {
    return this.groups.update(sid, name, body);
  }

  @Delete('servers/:sid/iam/groups/:name')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({
    category: 'access',
    action: 'iam-group.delete',
    title: 'Deleted an S3 group',
    failureTitle: 'Failed to delete an S3 group',
  })
  @ApiOperation({ summary: 'Delete a group; its members keep their own policies' })
  async remove(@Param('sid') sid: string, @Param('name') name: string): Promise<void> {
    await this.groups.delete(sid, name);
  }
}
