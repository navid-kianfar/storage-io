import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  createS3UserRequestSchema,
  iamUserBulkRequestSchema,
  listIamUsersQuerySchema,
  setUserGroupsRequestSchema,
  setUserPoliciesRequestSchema,
  updateS3UserRequestSchema,
  type CreateS3UserResponse,
  type IamUserBulkRequest,
  type IamUserBulkResponse,
  type S3UserDetail,
  type S3UserList,
} from '@storage-io/contracts';
import { CSV_CONTENT_TYPE, csvFilenameHeader } from '../../common/csv';
import { dtoFrom } from '../../common/dto';
import { LogActivity } from '../../activity/activity.interceptor';
import { IamUsersService } from './iam-users.service';

class ListIamUsersQueryDto extends dtoFrom(listIamUsersQuerySchema) {}
class CreateS3UserDto extends dtoFrom(createS3UserRequestSchema) {}
class UpdateS3UserDto extends dtoFrom(updateS3UserRequestSchema) {}
class SetUserPoliciesDto extends dtoFrom(setUserPoliciesRequestSchema) {}
class SetUserGroupsDto extends dtoFrom(setUserGroupsRequestSchema) {}

/**
 * **Route order is load bearing.** `iam/users/export.csv` is a literal GET and
 * `iam/users/:userId` is a parameter GET, so the literal is declared first or
 * Express reads "export.csv" as an id.
 */
@ApiTags('iam-users')
@Controller()
export class IamUsersController {
  constructor(private readonly users: IamUsersService) {}

  @Get('iam/users')
  @ApiOperation({ summary: 'S3 users across every server that has them' })
  async list(@Query() query: ListIamUsersQueryDto): Promise<S3UserList> {
    return this.users.list(query);
  }

  @Get('iam/users/export.csv')
  @Header('Content-Type', CSV_CONTENT_TYPE)
  @Header('Content-Disposition', csvFilenameHeader('s3-users.csv'))
  @ApiOperation({ summary: 'The filtered user list as CSV' })
  async exportCsv(@Query() query: ListIamUsersQueryDto): Promise<string> {
    return this.users.exportCsv(query);
  }

  /**
   * One action over many users. Always 200 with a row per user, never a 4xx for a
   * partial failure: the caller needs to know which users it applied to. The pipe
   * is on the parameter because the body is a discriminated union — `payload` is
   * typed by `action` — and a DTO class cannot extend a union type.
   */
  @Post('iam/users/bulk')
  @LogActivity({
    category: 'access',
    action: 'iam-user.bulk',
    title: 'Applied a bulk action to S3 users',
    failureTitle: 'Failed to apply a bulk action to S3 users',
  })
  @ApiOperation({ summary: 'Apply one action to many S3 users' })
  async bulk(
    @Body(new ZodValidationPipe(iamUserBulkRequestSchema)) body: IamUserBulkRequest,
  ): Promise<IamUserBulkResponse> {
    return this.users.bulk(body);
  }

  @Get('iam/users/:userId')
  @ApiOperation({ summary: 'One S3 user by its opaque id' })
  async findById(@Param('userId') userId: string): Promise<S3UserDetail> {
    return this.users.findById(userId);
  }

  @Post('servers/:sid/iam/users')
  @HttpCode(HttpStatus.CREATED)
  @LogActivity({
    category: 'access',
    action: 'iam-user.create',
    title: 'Created an S3 user',
    failureTitle: 'Failed to create an S3 user',
  })
  @ApiOperation({ summary: 'Create an S3 user, optionally with its first access key' })
  async create(
    @Param('sid') sid: string,
    @Body() body: CreateS3UserDto,
  ): Promise<CreateS3UserResponse> {
    return this.users.create(sid, body);
  }

  @Get('servers/:sid/iam/users/:name')
  @ApiOperation({ summary: 'One user, with its keys and inherited policies' })
  async findOne(@Param('sid') sid: string, @Param('name') name: string): Promise<S3UserDetail> {
    return this.users.findOne(sid, name);
  }

  @Patch('servers/:sid/iam/users/:name')
  @LogActivity({
    category: 'access',
    action: 'iam-user.status',
    title: "Changed an S3 user's status",
    failureTitle: "Failed to change an S3 user's status",
  })
  @ApiOperation({ summary: 'Enable or disable a user' })
  async setStatus(
    @Param('sid') sid: string,
    @Param('name') name: string,
    @Body() body: UpdateS3UserDto,
  ): Promise<S3UserDetail> {
    return this.users.setStatus(sid, name, body);
  }

  @Delete('servers/:sid/iam/users/:name')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({
    category: 'access',
    action: 'iam-user.delete',
    title: 'Deleted an S3 user',
    failureTitle: 'Failed to delete an S3 user',
  })
  @ApiOperation({ summary: 'Delete a user and its access keys' })
  async remove(@Param('sid') sid: string, @Param('name') name: string): Promise<void> {
    await this.users.delete(sid, name);
  }

  @Put('servers/:sid/iam/users/:name/policies')
  @LogActivity({
    category: 'access',
    action: 'iam-user.policies',
    title: "Changed an S3 user's policies",
    failureTitle: "Failed to change an S3 user's policies",
  })
  @ApiOperation({ summary: "Replace the user's attached policies with this set" })
  async setPolicies(
    @Param('sid') sid: string,
    @Param('name') name: string,
    @Body() body: SetUserPoliciesDto,
  ): Promise<S3UserDetail> {
    return this.users.setPolicies(sid, name, body);
  }

  @Put('servers/:sid/iam/users/:name/groups')
  @LogActivity({
    category: 'access',
    action: 'iam-user.groups',
    title: "Changed an S3 user's groups",
    failureTitle: "Failed to change an S3 user's groups",
  })
  @ApiOperation({ summary: "Replace the user's group membership with this set" })
  async setGroups(
    @Param('sid') sid: string,
    @Param('name') name: string,
    @Body() body: SetUserGroupsDto,
  ): Promise<S3UserDetail> {
    return this.users.setGroups(sid, name, body);
  }
}
