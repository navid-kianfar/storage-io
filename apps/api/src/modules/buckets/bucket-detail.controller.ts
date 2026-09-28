import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  Bucket,
  BucketAccessResponse,
  BucketCorsBody,
  BucketDetail,
  BucketLifecycleBody,
  BucketNotificationsBody,
  BucketObjectLockResponse,
  BucketPolicyBody,
  BucketQuotaResponse,
  BucketReplicationResponse,
  BucketTagsBody,
  BucketVersioning,
  Job,
  NotificationTargetStatusList,
} from '@storage-io/contracts';
import { LogActivity } from '../../activity/activity.interceptor';
import { BucketSettingsService } from './bucket-settings.service';
import { BucketsService } from './buckets.service';
import {
  BucketAccessDto,
  BucketCorsDto,
  BucketLifecycleDto,
  BucketNotificationsDto,
  BucketObjectLockDto,
  BucketPolicyDto,
  BucketQuotaDto,
  BucketReplicationDto,
  BucketTagsDto,
  BucketVersioningDto,
  CreateBucketDto,
  DeleteBucketQueryDto,
  EmptyBucketDto,
} from './buckets.dto';

/**
 * Everything under `/servers/:sid/buckets`.
 *
 * **Route order is load bearing.** `POST /servers/:sid/buckets` is declared before
 * the `:bucket` routes, and every sub-resource is a literal segment after
 * `:bucket`, so Express cannot match `empty` or `quota` as a bucket name.
 */
@ApiTags('buckets')
@Controller('servers/:sid/buckets')
export class BucketDetailController {
  constructor(
    private readonly buckets: BucketsService,
    private readonly settings: BucketSettingsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @LogActivity({ category: 'buckets', action: 'bucket.create', title: 'Created a bucket' })
  @ApiOperation({ summary: 'Create a bucket, with versioning, lock, quota and access' })
  async create(@Param('sid') sid: string, @Body() body: CreateBucketDto): Promise<Bucket> {
    return this.buckets.create(sid, body);
  }

  @Get(':bucket')
  @ApiOperation({ summary: 'One bucket, read live from the server' })
  async detail(@Param('sid') sid: string, @Param('bucket') bucket: string): Promise<BucketDetail> {
    return this.buckets.detail(sid, bucket);
  }

  @Delete(':bucket')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({ category: 'buckets', action: 'bucket.delete', title: 'Deleted a bucket' })
  @ApiOperation({ summary: 'Delete a bucket; force empties it first' })
  async remove(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: DeleteBucketQueryDto,
  ): Promise<void> {
    await this.buckets.remove(sid, bucket, query.force);
  }

  @Post(':bucket/empty')
  @HttpCode(HttpStatus.ACCEPTED)
  @LogActivity({ category: 'buckets', action: 'bucket.empty', title: 'Queued a bucket empty' })
  @ApiOperation({ summary: 'Empty a bucket as a background job' })
  empty(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: EmptyBucketDto,
  ): Job {
    return this.buckets.empty(sid, bucket, body.includeVersions);
  }

  /* ------------------------------- access -------------------------- */

  @Get(':bucket/access')
  @ApiOperation({ summary: 'The bucket’s access level and its policy' })
  async getAccess(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
  ): Promise<BucketAccessResponse> {
    return this.settings.getAccess(sid, bucket);
  }

  @Put(':bucket/access')
  @LogActivity({ category: 'access', action: 'bucket.access', title: 'Changed bucket access' })
  @ApiOperation({ summary: 'Apply the private or public-read preset' })
  async setAccess(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: BucketAccessDto,
  ): Promise<BucketAccessResponse> {
    return this.settings.setAccess(sid, bucket, body.access);
  }

  @Get(':bucket/policy')
  @ApiOperation({ summary: 'The raw bucket policy' })
  async getPolicy(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
  ): Promise<BucketPolicyBody> {
    return this.settings.getPolicy(sid, bucket);
  }

  @Put(':bucket/policy')
  @LogActivity({ category: 'access', action: 'bucket.policy', title: 'Changed a bucket policy' })
  @ApiOperation({ summary: 'Replace the bucket policy; null removes it' })
  async setPolicy(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: BucketPolicyDto,
  ): Promise<BucketPolicyBody> {
    return this.settings.setPolicy(sid, bucket, body.policy);
  }

  /* ----------------------------- versioning ------------------------ */

  @Get(':bucket/versioning')
  @ApiOperation({ summary: 'Versioning state' })
  async getVersioning(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
  ): Promise<{ status: BucketVersioning }> {
    return this.settings.getVersioning(sid, bucket);
  }

  @Put(':bucket/versioning')
  @LogActivity({ category: 'buckets', action: 'bucket.versioning', title: 'Changed versioning' })
  @ApiOperation({ summary: 'Enable or suspend versioning' })
  async setVersioning(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: BucketVersioningDto,
  ): Promise<{ status: BucketVersioning }> {
    return this.settings.setVersioning(sid, bucket, body);
  }

  /* ----------------------------- object lock ----------------------- */

  @Get(':bucket/object-lock')
  @ApiOperation({ summary: 'Object lock and its default retention' })
  async getObjectLock(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
  ): Promise<BucketObjectLockResponse> {
    return this.settings.getObjectLock(sid, bucket);
  }

  @Put(':bucket/object-lock')
  @LogActivity({ category: 'buckets', action: 'bucket.object-lock', title: 'Changed object lock' })
  @ApiOperation({
    summary: 'Change the default retention (NOT_SUPPORTED unless lock is already on)',
  })
  async setObjectLock(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: BucketObjectLockDto,
  ): Promise<BucketObjectLockResponse> {
    return this.settings.setObjectLock(sid, bucket, body);
  }

  /* ------------------------------ lifecycle ------------------------ */

  @Get(':bucket/lifecycle')
  @ApiOperation({ summary: 'Lifecycle rules' })
  async getLifecycle(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
  ): Promise<BucketLifecycleBody> {
    return this.settings.getLifecycle(sid, bucket);
  }

  @Put(':bucket/lifecycle')
  @LogActivity({
    category: 'buckets',
    action: 'bucket.lifecycle',
    title: 'Changed lifecycle rules',
  })
  @ApiOperation({ summary: 'Replace the lifecycle rules; an empty list removes them' })
  async setLifecycle(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: BucketLifecycleDto,
  ): Promise<BucketLifecycleBody> {
    return this.settings.setLifecycle(sid, bucket, body);
  }

  /* --------------------------------- CORS -------------------------- */

  @Get(':bucket/cors')
  @ApiOperation({ summary: 'CORS rules' })
  async getCors(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
  ): Promise<BucketCorsBody> {
    return this.settings.getCors(sid, bucket);
  }

  @Put(':bucket/cors')
  @LogActivity({ category: 'buckets', action: 'bucket.cors', title: 'Changed CORS rules' })
  @ApiOperation({ summary: 'Replace the CORS rules; an empty list removes them' })
  async setCors(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: BucketCorsDto,
  ): Promise<BucketCorsBody> {
    return this.settings.setCors(sid, bucket, body);
  }

  /* --------------------------------- tags -------------------------- */

  @Get(':bucket/tags')
  @ApiOperation({ summary: 'Bucket tags' })
  async getTags(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
  ): Promise<BucketTagsBody> {
    return this.settings.getTags(sid, bucket);
  }

  @Put(':bucket/tags')
  @LogActivity({ category: 'buckets', action: 'bucket.tags', title: 'Changed bucket tags' })
  @ApiOperation({ summary: 'Replace the bucket tags; an empty map removes them' })
  async setTags(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: BucketTagsDto,
  ): Promise<BucketTagsBody> {
    return this.settings.setTags(sid, bucket, body);
  }

  /* ------------------------------ replication ---------------------- */

  @Get(':bucket/replication')
  @ApiOperation({ summary: 'Replication rules and their aggregate status' })
  async getReplication(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
  ): Promise<BucketReplicationResponse> {
    return this.settings.getReplication(sid, bucket);
  }

  @Put(':bucket/replication')
  @LogActivity({ category: 'buckets', action: 'bucket.replication', title: 'Changed replication' })
  @ApiOperation({ summary: 'Replace the replication rules; an empty list removes them' })
  async setReplication(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: BucketReplicationDto,
  ): Promise<BucketReplicationResponse> {
    return this.settings.setReplication(sid, bucket, body);
  }

  /* ---------------------------- notifications ---------------------- */

  @Get(':bucket/notifications/status')
  @ApiOperation({ summary: 'Delivery state per target (unknown outside MinIO)' })
  async notificationStatus(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
  ): Promise<NotificationTargetStatusList> {
    return { items: [...(await this.settings.notificationStatus(sid, bucket))] };
  }

  @Get(':bucket/notifications')
  @ApiOperation({ summary: 'Event notification targets' })
  async getNotifications(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
  ): Promise<BucketNotificationsBody> {
    return this.settings.getNotifications(sid, bucket);
  }

  @Put(':bucket/notifications')
  @LogActivity({
    category: 'buckets',
    action: 'bucket.notifications',
    title: 'Changed event notifications',
  })
  @ApiOperation({ summary: 'Replace the notification targets' })
  async setNotifications(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: BucketNotificationsDto,
  ): Promise<BucketNotificationsBody> {
    return this.settings.setNotifications(sid, bucket, body);
  }

  /* -------------------------------- quota -------------------------- */

  @Get(':bucket/quota')
  @ApiOperation({ summary: 'The bucket’s quota and its current usage' })
  getQuota(@Param('sid') sid: string, @Param('bucket') bucket: string): BucketQuotaResponse {
    return this.settings.getQuota(sid, bucket);
  }

  @Put(':bucket/quota')
  @LogActivity({ category: 'buckets', action: 'bucket.quota', title: 'Changed a bucket quota' })
  @ApiOperation({ summary: 'Set or clear the quota; native where the provider has one' })
  async setQuota(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: BucketQuotaDto,
  ): Promise<BucketQuotaResponse> {
    return this.settings.setQuota(sid, bucket, body);
  }
}
