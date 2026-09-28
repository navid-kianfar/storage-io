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
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  UPLOAD_HEADERS,
  objectBatchRequestSchema,
  objectRetentionBodySchema,
  type CopyObjectsResponse,
  type DeleteObjectsResponse,
  type ListObjectsResponse,
  type ObjectItem,
  type ArchiveEntriesResponse,
  type CreateMultipartUploadResponse,
  type MultipartPartList,
  type ObjectBatchRequest,
  type ObjectBatchResponse,
  type ObjectMeta,
  type ObjectRetentionBody,
  type ObjectTagsBody,
  type ObjectVersionList,
  type PresignResponse,
  type UploadPartResponse,
} from '@storage-io/contracts';
import { LogActivity, SkipActivity } from '../../activity/activity.interceptor';
import { ActivityService } from '../../activity/activity.service';
import { SYSTEM_ACTOR, actorOf, clientIpOf } from '../../common/actor';
import { requestIdOf } from '../../common/request-id';
import { ObjectsService, basename, type UploadHeaders } from './objects.service';
import { ArchiveReaderService } from './archive-reader.service';
import { MultipartService } from './multipart.service';
import { basenameOf } from './object-stream.service';
import {
  ArchiveEntriesQueryDto,
  CompleteMultipartUploadDto,
  CopyObjectsDto,
  CreateFolderDto,
  CreateMultipartUploadDto,
  DeleteObjectsDto,
  DownloadObjectQueryDto,
  DownloadZipDto,
  ImportUrlDto,
  ListObjectsQueryDto,
  MultipartKeyQueryDto,
  ObjectKeyQueryDto,
  ObjectMetadataDto,
  ObjectTagsDto,
  PresignDto,
  PutObjectContentQueryDto,
  RenameObjectDto,
  RestoreVersionDto,
  SetStorageClassDto,
  UploadObjectQueryDto,
} from './objects.dto';

/**
 * Thin, like every controller here: validate, delegate, map. The two things it
 * does own are HTTP-shaped and belong nowhere else — the `@Res()` streaming routes,
 * and reading the `X-Sio-*` upload headers into the shape the service takes.
 *
 * Downloads are recorded in the activity log explicitly, because the global
 * interceptor only covers mutating methods and a download with its byte count is
 * exactly what an operator looks for in an audit trail.
 */
@ApiTags('objects')
@Controller('servers/:sid/buckets/:bucket/objects')
export class ObjectsController {
  constructor(
    private readonly objects: ObjectsService,
    private readonly multipart: MultipartService,
    private readonly archives: ArchiveReaderService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List one level of a bucket, or its versions' })
  async list(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: ListObjectsQueryDto,
  ): Promise<ListObjectsResponse> {
    return this.objects.list(sid, bucket, query);
  }

  @Get('meta')
  @ApiOperation({ summary: 'One object: headers, metadata, tags, retention' })
  async meta(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: ObjectKeyQueryDto,
  ): Promise<ObjectMeta> {
    return this.objects.meta(sid, bucket, query.key, query.versionId);
  }

  @Get('versions')
  @ApiOperation({ summary: 'Every version of one key, newest first' })
  async versions(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: ObjectKeyQueryDto,
  ): Promise<ObjectVersionList> {
    return { items: [...(await this.objects.versions(sid, bucket, query.key))] };
  }

  /**
   * Streams the object, honouring `Range`. `@Res()` hands the response over: a
   * download is bytes on the wire, not a value Nest serialises.
   */
  @Get('download')
  @ApiOperation({ summary: 'Download an object; honours Range' })
  async download(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: DownloadObjectQueryDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const context = this.objects.contextFor(sid);
    const range = request.headers.range;

    const bytes = await this.objects.stream.download(context.client, response, {
      bucket,
      key: query.key,
      ...(query.versionId === undefined ? {} : { versionId: query.versionId }),
      inline: query.inline,
      ...(range === undefined ? {} : { range }),
    });

    this.record(request, {
      action: 'object.download',
      title: `Downloaded ${basenameOf(query.key)}`,
      target: query.key,
      serverId: context.row.id,
      serverName: context.row.name,
      details: { bucket, key: query.key, bytes, ranged: range !== undefined },
    });
  }

  @Post('download-zip')
  @LogActivity({
    category: 'objects',
    action: 'object.download-zip',
    title: 'Downloaded a ZIP of a selection',
  })
  @ApiOperation({ summary: 'Stream a ZIP of the selected keys and prefixes' })
  async downloadZip(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: DownloadZipDto,
    @Res() response: Response,
  ): Promise<void> {
    const context = this.objects.contextFor(sid);
    const stamp = new Date().toISOString().slice(0, 10);
    await this.objects.stream.zip(
      context.client,
      response,
      bucket,
      body.keys,
      body.prefixes,
      `${bucket}-${stamp}.zip`,
    );
  }

  /**
   * The raw streamed upload. The body never reaches a body parser — see
   * `raw-upload.ts` — so `request` is still an unread stream here.
   */
  @Put('upload')
  @LogActivity({ category: 'objects', action: 'object.upload', title: 'Uploaded an object' })
  @ApiOperation({ summary: 'Upload an object from the raw request body' })
  async upload(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: UploadObjectQueryDto,
    @Req() request: Request,
  ): Promise<ObjectItem> {
    return this.objects.upload(
      sid,
      bucket,
      query.key,
      query.overwrite,
      request,
      uploadHeadersOf(request),
    );
  }

  @Put('content')
  @LogActivity({ category: 'objects', action: 'object.edit', title: 'Edited an object in place' })
  @ApiOperation({ summary: 'Replace an object from a text body, creating a new version' })
  async putContent(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: PutObjectContentQueryDto,
    @Req() request: Request,
  ): Promise<ObjectItem> {
    return this.objects.putContent(sid, bucket, query.key, request);
  }

  @Post('folder')
  @HttpCode(HttpStatus.CREATED)
  @LogActivity({ category: 'objects', action: 'object.folder', title: 'Created a folder' })
  @ApiOperation({ summary: 'Create a folder placeholder' })
  async createFolder(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: CreateFolderDto,
  ): Promise<void> {
    await this.objects.createFolder(sid, bucket, body);
  }

  @Post('delete')
  @LogActivity({ category: 'objects', action: 'object.delete', title: 'Deleted objects' })
  @ApiOperation({ summary: 'Delete objects, versions or prefixes' })
  async remove(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: DeleteObjectsDto,
  ): Promise<DeleteObjectsResponse> {
    return this.objects.remove(sid, bucket, body);
  }

  @Post('copy')
  @LogActivity({ category: 'objects', action: 'object.copy', title: 'Copied or moved objects' })
  @ApiOperation({ summary: 'Copy or move objects, across buckets and servers' })
  async copy(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: CopyObjectsDto,
  ): Promise<CopyObjectsResponse> {
    return this.objects.copy(sid, bucket, body);
  }

  @Post('rename')
  @LogActivity({ category: 'objects', action: 'object.rename', title: 'Renamed an object' })
  @ApiOperation({ summary: 'Rename an object, keeping its metadata and tags' })
  async rename(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: RenameObjectDto,
  ): Promise<ObjectItem> {
    return this.objects.rename(sid, bucket, body);
  }

  @Post('restore-version')
  @LogActivity({
    category: 'objects',
    action: 'object.restore-version',
    title: 'Restored an object version',
  })
  @ApiOperation({ summary: 'Copy an old version over the current one' })
  async restoreVersion(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: RestoreVersionDto,
  ): Promise<ObjectItem> {
    return this.objects.restoreVersion(sid, bucket, body);
  }

  @Get('tags')
  @ApiOperation({ summary: 'Object tags' })
  async getTags(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: ObjectKeyQueryDto,
  ): Promise<ObjectTagsBody> {
    return this.objects.getTags(sid, bucket, query.key, query.versionId);
  }

  @Put('tags')
  @LogActivity({ category: 'objects', action: 'object.tags', title: 'Changed object tags' })
  @ApiOperation({ summary: 'Replace an object’s tags' })
  async setTags(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: ObjectKeyQueryDto,
    @Body() body: ObjectTagsDto,
  ): Promise<ObjectTagsBody> {
    return this.objects.setTags(sid, bucket, query.key, query.versionId, body);
  }

  @Put('metadata')
  @LogActivity({ category: 'objects', action: 'object.metadata', title: 'Edited object metadata' })
  @ApiOperation({ summary: 'Replace content headers and user metadata' })
  async setMetadata(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: ObjectKeyQueryDto,
    @Body() body: ObjectMetadataDto,
  ): Promise<ObjectMeta> {
    return this.objects.setMetadata(sid, bucket, query.key, body);
  }

  @Put('storage-class')
  @LogActivity({
    category: 'objects',
    action: 'object.storage-class',
    title: 'Changed an object’s storage class',
  })
  @ApiOperation({ summary: 'Change the storage class of one object' })
  async setStorageClass(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: ObjectKeyQueryDto,
    @Body() body: SetStorageClassDto,
  ): Promise<ObjectMeta> {
    return this.objects.setStorageClass(sid, bucket, query.key, body);
  }

  @Put('retention')
  @LogActivity({
    category: 'objects',
    action: 'object.retention',
    title: 'Changed retention or legal hold',
  })
  @ApiOperation({ summary: 'Set object retention, or turn legal hold on or off' })
  // The body is a union — a retention rule or a legal-hold flag — so it is
  // validated by an explicit pipe rather than a DTO class. See objects.dto.ts.
  async setRetention(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: ObjectKeyQueryDto,
    @Body(new ZodValidationPipe(objectRetentionBodySchema)) body: ObjectRetentionBody,
  ): Promise<ObjectMeta> {
    return this.objects.setRetention(sid, bucket, query.key, query.versionId, body);
  }

  @Post('presign')
  @LogActivity({ category: 'objects', action: 'object.presign', title: 'Created a share link' })
  @ApiOperation({ summary: 'Presign a GET URL with an expiry' })
  async presign(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: PresignDto,
  ): Promise<PresignResponse> {
    return this.objects.presign(sid, bucket, body);
  }

  @Post('import-url')
  @LogActivity({ category: 'objects', action: 'object.import-url', title: 'Imported from a URL' })
  @ApiOperation({ summary: 'Fetch a URL server-side and stream it into the bucket' })
  async importUrl(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: ImportUrlDto,
  ): Promise<ObjectItem> {
    return this.objects.importUrl(sid, bucket, body);
  }

  /* -------------------------- batch over keys ---------------------- */

  /**
   * One metadata-only action over a selection, applied now. Always 200 with an
   * `updated` count and a row per failure — a selection where one object is locked
   * must still apply to the rest, which is why this is not a 4xx on partial failure.
   *
   * The pipe is on the parameter because the body is a discriminated union, so a tag
   * set cannot be sent down the retention path; a class cannot extend a union type.
   */
  @Post('batch')
  @LogActivity({
    category: 'objects',
    action: 'object.batch',
    title: 'Applied an action to a selection of objects',
  })
  @ApiOperation({ summary: 'Apply tags, storage class, retention or legal hold to many keys' })
  async batch(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body(new ZodValidationPipe(objectBatchRequestSchema)) body: ObjectBatchRequest,
  ): Promise<ObjectBatchResponse> {
    return this.objects.batch(sid, bucket, body);
  }

  /* --------------------------- archive preview ---------------------- */

  @Get('archive-entries')
  @ApiOperation({ summary: 'List what is inside a ZIP or tar object, without downloading it' })
  async archiveEntries(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Query() query: ArchiveEntriesQueryDto,
  ): Promise<ArchiveEntriesResponse> {
    const context = this.objects.contextFor(sid);
    return this.archives.list(context.client, bucket, query.key, query.versionId, query.limit);
  }

  /* ---------------------- resumable multipart upload ---------------- */

  @Post('multipart')
  @HttpCode(HttpStatus.CREATED)
  @LogActivity({
    category: 'objects',
    action: 'object.multipart-start',
    title: 'Started a resumable upload',
  })
  @ApiOperation({ summary: 'Begin a resumable multipart upload' })
  async createMultipart(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Body() body: CreateMultipartUploadDto,
  ): Promise<CreateMultipartUploadResponse> {
    const context = this.objects.contextFor(sid);
    return this.multipart.create(context, bucket, body);
  }

  /**
   * One part, streamed. Like `…/objects/upload`, the body never reaches a body
   * parser — see `raw-upload.ts` — so `request` is still an unread stream here.
   *
   * Deliberately not activity-logged: a large upload is thousands of these, and an
   * audit trail with a row per part buries the entry that matters. The start,
   * completion and abort are logged instead.
   */
  @Put('multipart/:uploadId/parts/:partNumber')
  @SkipActivity()
  @ApiOperation({ summary: 'Upload one part of a resumable upload' })
  async uploadPart(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Param('uploadId') uploadId: string,
    @Param('partNumber') partNumber: string,
    @Query() query: MultipartKeyQueryDto,
    @Req() request: Request,
  ): Promise<UploadPartResponse> {
    const context = this.objects.contextFor(sid);
    const declared = Number(request.headers['content-length'] ?? Number.NaN);

    return this.multipart.uploadPart(
      context,
      bucket,
      query.key,
      uploadId,
      // Parsed here rather than with ParseIntPipe so a bad value becomes the
      // service's own VALIDATION message, which names the allowed range.
      Number(partNumber),
      request,
      Number.isFinite(declared) ? declared : null,
    );
  }

  @Get('multipart/:uploadId')
  @ApiOperation({ summary: 'The parts already stored, so an upload can resume' })
  async listParts(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Param('uploadId') uploadId: string,
    @Query() query: MultipartKeyQueryDto,
  ): Promise<MultipartPartList> {
    const context = this.objects.contextFor(sid);
    const parts = await this.multipart.listParts(context, bucket, query.key, uploadId);
    return { parts: [...parts] };
  }

  @Post('multipart/:uploadId/complete')
  @LogActivity({
    category: 'objects',
    action: 'object.multipart-complete',
    title: 'Finished a resumable upload',
  })
  @ApiOperation({ summary: 'Assemble the parts into the object' })
  async completeMultipart(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Param('uploadId') uploadId: string,
    @Query() query: MultipartKeyQueryDto,
    @Body() body: CompleteMultipartUploadDto,
  ): Promise<ObjectItem> {
    const context = this.objects.contextFor(sid);
    return this.multipart.complete(context, bucket, query.key, uploadId, body);
  }

  @Delete('multipart/:uploadId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({
    category: 'objects',
    action: 'object.multipart-abort',
    title: 'Cancelled a resumable upload',
  })
  @ApiOperation({ summary: 'Abort a resumable upload and discard its parts' })
  async abortMultipart(
    @Param('sid') sid: string,
    @Param('bucket') bucket: string,
    @Param('uploadId') uploadId: string,
    @Query() query: MultipartKeyQueryDto,
  ): Promise<void> {
    const context = this.objects.contextFor(sid);
    await this.multipart.abort(context, bucket, query.key, uploadId);
  }

  /* ------------------------------ internals ------------------------ */

  /** A GET the interceptor does not cover, recorded by hand with its byte count. */
  private record(
    request: Request,
    entry: {
      action: string;
      title: string;
      target: string;
      serverId: string;
      serverName: string;
      details: Record<string, unknown>;
    },
  ): void {
    const actor = actorOf(request) ?? SYSTEM_ACTOR;
    this.activity.record({
      category: 'objects',
      action: entry.action,
      title: entry.title,
      actor: { type: actor.type, name: actor.name },
      result: 'success',
      target: entry.target,
      serverId: entry.serverId,
      serverName: entry.serverName,
      ip: clientIpOf(request),
      requestId: requestIdOf(request),
      details: entry.details,
    });
  }
}

/* ------------------------------ helpers --------------------------- */

/**
 * The upload's out-of-band instructions, carried in headers because the body is
 * the object. Spellings come from `UPLOAD_HEADERS` in the contract, so the web app
 * and the API cannot disagree about them.
 */
export function uploadHeadersOf(request: Request): UploadHeaders {
  const metadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!name.toLowerCase().startsWith(UPLOAD_HEADERS.metaPrefix)) continue;
    const key = name.slice(UPLOAD_HEADERS.metaPrefix.length);
    if (key.length === 0) continue;
    metadata[key] = Array.isArray(value) ? (value[0] ?? '') : String(value ?? '');
  }

  const declaredLength = Number(request.headers['content-length'] ?? Number.NaN);

  return {
    contentType: headerOf(request, 'content-type'),
    contentLength: Number.isFinite(declaredLength) ? declaredLength : null,
    metadata,
    tags: parseTagHeader(headerOf(request, UPLOAD_HEADERS.tags)),
    storageClass: headerOf(request, UPLOAD_HEADERS.storageClass),
  };
}

const headerOf = (request: Request, name: string): string | null => {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** `X-Sio-Tags` is a URL-encoded query string, the same spelling S3 uses. */
export function parseTagHeader(header: string | null): Record<string, string> {
  if (header === null) return {};
  const tags: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(header)) {
    if (key.length === 0) continue;
    tags[key] = value;
  }
  return tags;
}

export { basename };
