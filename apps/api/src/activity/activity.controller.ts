import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  ACTIVITY_CSV_COLUMNS,
  listActivityQuerySchema,
  paginationQuerySchema,
  type ActivityEvent,
  type ActivityList,
} from '@storage-io/contracts';
import { dtoFrom } from '../common/dto';
import { NotFoundError } from '../common/errors/domain.exception';
import { CSV_BOM, CSV_CONTENT_TYPE, csvFilenameHeader, csvRow } from '../common/csv';
import { ActivityService } from './activity.service';

class ListActivityQueryDto extends dtoFrom(listActivityQuerySchema.merge(paginationQuerySchema)) {}
class ExportActivityQueryDto extends dtoFrom(listActivityQuerySchema) {}

@ApiTags('activity')
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @ApiOperation({ summary: 'List activity events' })
  list(@Query() query: ListActivityQueryDto): ActivityList {
    const { page, pageSize, ...filters } = query;
    return this.activity.list(filters, { page, pageSize });
  }

  /**
   * Declared before `:id` on purpose — Express matches in order, so `:id` would
   * otherwise swallow `export.csv`.
   */
  @Get('export.csv')
  @ApiOperation({ summary: 'Export the filtered activity log as CSV' })
  export(@Query() query: ExportActivityQueryDto, @Res() response: Response): void {
    const stamp = new Date().toISOString().slice(0, 10);
    response.setHeader('Content-Type', CSV_CONTENT_TYPE);
    response.setHeader('Content-Disposition', csvFilenameHeader(`activity-${stamp}.csv`));
    response.write(CSV_BOM);
    response.write(csvRow(ACTIVITY_CSV_COLUMNS));

    for (const event of this.activity.iterateForExport(query)) {
      response.write(csvRow(toCsvCells(event)));
    }
    response.end();
  }

  @Get(':id')
  @ApiOperation({ summary: 'One activity event, with its raw details' })
  findOne(@Param('id') id: string): ActivityEvent {
    const event = this.activity.findById(id);
    if (event === null) throw new NotFoundError('No such activity event.');
    return event;
  }
}

/** Column order must match `ACTIVITY_CSV_COLUMNS`. */
function toCsvCells(event: ActivityEvent): readonly unknown[] {
  return [
    event.at,
    event.category,
    event.action,
    event.title,
    event.actor.type,
    event.actor.name,
    event.target,
    event.serverName,
    event.ip,
    event.result,
    event.requestId,
    event.details,
  ];
}
