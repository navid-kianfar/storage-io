import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  QUOTA_CSV_COLUMNS,
  listQuotasQuerySchema,
  paginationQuerySchema,
  type QuotaList,
  type QuotaRow,
} from '@storage-io/contracts';
import { CSV_BOM, CSV_CONTENT_TYPE, csvFilenameHeader, csvRow } from '../../common/csv';
import { dtoFrom } from '../../common/dto';
import { QuotasService, usageRatioOf } from './quotas.service';

class ListQuotasQueryDto extends dtoFrom(listQuotasQuerySchema.merge(paginationQuerySchema)) {}
class ExportQuotasQueryDto extends dtoFrom(listQuotasQuerySchema) {}

@ApiTags('quotas')
@Controller('quotas')
export class QuotasController {
  constructor(private readonly quotas: QuotasService) {}

  @Get()
  @ApiOperation({ summary: 'Bucket quotas with usage ratios and trends' })
  list(@Query() query: ListQuotasQueryDto): QuotaList {
    const { page, pageSize, ...filters } = query;
    return this.quotas.list(filters, { page, pageSize });
  }

  @Get('export.csv')
  @ApiOperation({ summary: 'Export the filtered quota list as CSV' })
  export(@Query() query: ExportQuotasQueryDto, @Res() response: Response): void {
    const stamp = new Date().toISOString().slice(0, 10);
    response.setHeader('Content-Type', CSV_CONTENT_TYPE);
    response.setHeader('Content-Disposition', csvFilenameHeader(`quotas-${stamp}.csv`));
    response.write(CSV_BOM);
    response.write(csvRow(QUOTA_CSV_COLUMNS));

    for (const row of this.quotas.iterateForExport(query)) {
      response.write(csvRow(toCsvCells(row)));
    }
    response.end();
  }
}

/** Column order must match `QUOTA_CSV_COLUMNS`. */
function toCsvCells(row: QuotaRow): readonly unknown[] {
  const { bucket } = row;
  return [
    bucket.serverName,
    bucket.provider,
    bucket.name,
    bucket.quota?.limitBytes ?? null,
    bucket.quota?.mode ?? null,
    bucket.quota?.threshold ?? null,
    bucket.quota?.native ?? null,
    row.supported,
    bucket.sizeBytes,
    bucket.objects,
    usageRatioOf(bucket),
    bucket.statsAt,
  ];
}
