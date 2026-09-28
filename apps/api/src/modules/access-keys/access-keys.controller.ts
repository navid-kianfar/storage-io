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
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createAccessKeyRequestSchema,
  listAccessKeysQuerySchema,
  rotateAccessKeyRequestSchema,
  updateAccessKeyRequestSchema,
  type AccessKey,
  type AccessKeyList,
  type CreatedKey,
} from '@storage-io/contracts';
import { CSV_CONTENT_TYPE, csvFilenameHeader } from '../../common/csv';
import { dtoFrom } from '../../common/dto';
import { LogActivity } from '../../activity/activity.interceptor';
import { AccessKeysService } from './access-keys.service';

class ListAccessKeysQueryDto extends dtoFrom(listAccessKeysQuerySchema) {}
class CreateAccessKeyDto extends dtoFrom(createAccessKeyRequestSchema) {}
class UpdateAccessKeyDto extends dtoFrom(updateAccessKeyRequestSchema) {}
class RotateAccessKeyDto extends dtoFrom(rotateAccessKeyRequestSchema) {}

/**
 * Thin: validate, delegate, map. The aggregated routes and the per-server ones sit
 * in one controller because they are one resource; `export.csv` is declared before
 * nothing that could shadow it, since every per-key path lives under
 * `/servers/:sid/`.
 */
@ApiTags('access-keys')
@Controller()
export class AccessKeysController {
  constructor(private readonly keys: AccessKeysService) {}

  @Get('iam/access-keys')
  @ApiOperation({ summary: 'Access keys across every server that has them' })
  async list(@Query() query: ListAccessKeysQueryDto): Promise<AccessKeyList> {
    return this.keys.list(query);
  }

  @Get('iam/access-keys/export.csv')
  @Header('Content-Type', CSV_CONTENT_TYPE)
  @Header('Content-Disposition', csvFilenameHeader('access-keys.csv'))
  @ApiOperation({ summary: 'The filtered access-key list as CSV' })
  async exportCsv(@Query() query: ListAccessKeysQueryDto): Promise<string> {
    return this.keys.exportCsv(query);
  }

  @Post('servers/:sid/iam/access-keys')
  @HttpCode(HttpStatus.CREATED)
  @LogActivity({
    category: 'access',
    action: 'access-key.create',
    title: 'Created an access key',
    failureTitle: 'Failed to create an access key',
  })
  @ApiOperation({ summary: 'Create an access key; the secret is returned once' })
  async create(@Param('sid') sid: string, @Body() body: CreateAccessKeyDto): Promise<CreatedKey> {
    return this.keys.create(sid, body);
  }

  @Patch('servers/:sid/iam/access-keys/:accessKeyId')
  @LogActivity({
    category: 'access',
    action: 'access-key.update',
    title: 'Edited an access key',
    failureTitle: 'Failed to edit an access key',
  })
  @ApiOperation({ summary: 'Rename, enable, disable or re-date an access key' })
  async update(
    @Param('sid') sid: string,
    @Param('accessKeyId') accessKeyId: string,
    @Body() body: UpdateAccessKeyDto,
  ): Promise<AccessKey> {
    return this.keys.update(sid, accessKeyId, body);
  }

  @Delete('servers/:sid/iam/access-keys/:accessKeyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({
    category: 'access',
    action: 'access-key.delete',
    title: 'Deleted an access key',
    failureTitle: 'Failed to delete an access key',
  })
  @ApiOperation({ summary: 'Delete an access key' })
  async remove(
    @Param('sid') sid: string,
    @Param('accessKeyId') accessKeyId: string,
  ): Promise<void> {
    await this.keys.delete(sid, accessKeyId);
  }

  @Post('servers/:sid/iam/access-keys/:accessKeyId/rotate')
  @LogActivity({
    category: 'access',
    action: 'access-key.rotate',
    title: 'Rotated an access key',
    failureTitle: 'Failed to rotate an access key',
  })
  @ApiOperation({ summary: 'Create a replacement and schedule the old key to be disabled' })
  async rotate(
    @Param('sid') sid: string,
    @Param('accessKeyId') accessKeyId: string,
    @Body() body: RotateAccessKeyDto,
  ): Promise<CreatedKey> {
    return this.keys.rotate(sid, accessKeyId, body);
  }
}
