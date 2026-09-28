import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  BUCKET_CSV_COLUMNS,
  bucketBulkRequestSchema,
  type Bucket,
  type BucketBulkRequest,
  type BucketBulkResponse,
  type BucketList,
} from '@storage-io/contracts';
import { LogActivity } from '../../activity/activity.interceptor';
import { CSV_BOM, CSV_CONTENT_TYPE, csvFilenameHeader, csvRow } from '../../common/csv';
import { BucketsService } from './buckets.service';
import { ExportBucketsQueryDto, ListBucketsQueryDto } from './buckets.dto';

/**
 * The installation-wide bucket endpoints. Per-bucket routes live in
 * `BucketDetailController`, under `/servers/:sid/buckets/:bucket`.
 *
 * `bulk` and `export.csv` are declared before nothing in particular here — this
 * controller has no `:param` route, so route order is not load bearing. It is in
 * `BucketDetailController` that it matters.
 */
@ApiTags('buckets')
@Controller('buckets')
export class BucketsController {
  constructor(private readonly buckets: BucketsService) {}

  @Get()
  @ApiOperation({ summary: 'Buckets across every server, with a summary' })
  list(@Query() query: ListBucketsQueryDto): BucketList {
    const { page, pageSize, ...filters } = query;
    return this.buckets.list(filters, { page, pageSize });
  }

  @Get('export.csv')
  @ApiOperation({ summary: 'Export the filtered bucket list as CSV' })
  export(@Query() query: ExportBucketsQueryDto, @Res() response: Response): void {
    const stamp = new Date().toISOString().slice(0, 10);
    response.setHeader('Content-Type', CSV_CONTENT_TYPE);
    response.setHeader('Content-Disposition', csvFilenameHeader(`buckets-${stamp}.csv`));
    response.write(CSV_BOM);
    response.write(csvRow(BUCKET_CSV_COLUMNS));

    for (const bucket of this.buckets.iterateForExport(query)) {
      response.write(csvRow(toCsvCells(bucket)));
    }
    response.end();
  }

  /**
   * One action over many buckets. Always 200 with a row per bucket, never a 4xx
   * for a partial failure: the caller needs to know which buckets it applied to.
   *
   * The pipe is on the parameter rather than a DTO class because the request body
   * is a discriminated union — `payload` is typed by `action`, so a lifecycle rule
   * cannot be sent down the quota path — and a class cannot extend a union type.
   */
  @Post('bulk')
  @LogActivity({
    category: 'buckets',
    action: 'bucket.bulk',
    title: 'Applied a bulk action to buckets',
  })
  @ApiOperation({ summary: 'Apply one action to many buckets' })
  async bulk(
    @Body(new ZodValidationPipe(bucketBulkRequestSchema)) body: BucketBulkRequest,
  ): Promise<BucketBulkResponse> {
    return this.buckets.bulk(body);
  }
}

/** Column order must match `BUCKET_CSV_COLUMNS`. */
function toCsvCells(bucket: Bucket): readonly unknown[] {
  return [
    bucket.serverName,
    bucket.provider,
    bucket.name,
    bucket.region,
    bucket.createdAt,
    bucket.objects,
    bucket.sizeBytes,
    bucket.statsAt,
    bucket.versioning,
    bucket.objectLock,
    bucket.access,
    bucket.quota?.limitBytes ?? null,
    bucket.quota?.mode ?? null,
    bucket.quota?.native ?? null,
    bucket.unavailable,
  ];
}
