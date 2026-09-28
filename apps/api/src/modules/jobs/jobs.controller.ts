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
import type {
  EstimateJobResponse,
  Job,
  JobList,
  JobLogsResponse,
  JobRunList,
} from '@storage-io/contracts';
import { LogActivity } from '../../activity/activity.interceptor';
import {
  CreateJobDto,
  DuplicateJobDto,
  EstimateJobDto,
  JobLogsQueryDto,
  ListJobsQueryDto,
  PaginationQueryDto,
  UpdateJobDto,
} from './jobs.dto';
import { JobsService } from './jobs.service';

/**
 * `/jobs`. Thin by policy: it validates, delegates and maps.
 *
 * **Route order is load bearing.** `estimate` sits above `:id`, or Express matches
 * the literal segment as a parameter and `POST /jobs/estimate` becomes
 * "duplicate the job called estimate". The same rule is why `/servers/test` sits
 * above `/servers/:id`.
 */
@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  @ApiOperation({ summary: 'Jobs in one view, with the counts for all three' })
  list(@Query() query: ListJobsQueryDto): JobList {
    const { page, pageSize, ...filters } = query;
    return this.jobs.list(filters, { page, pageSize });
  }

  @Post()
  @LogActivity({ category: 'jobs', action: 'job.create', title: 'Created a bulk job' })
  @ApiOperation({ summary: 'Create a job, scheduled now, at a time, or on a cron' })
  create(@Body() body: CreateJobDto): Job {
    return this.jobs.create(body);
  }

  @Post('estimate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Time-boxed count of what a job would touch' })
  estimate(@Body() body: EstimateJobDto): Promise<EstimateJobResponse> {
    return this.jobs.estimate(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One job, with live progress while it runs' })
  findOne(@Param('id') id: string): Job {
    return this.jobs.findOne(id);
  }

  @Patch(':id')
  @LogActivity({ category: 'jobs', action: 'job.update', title: 'Changed a bulk job' })
  @ApiOperation({ summary: 'Rename, change concurrency live, or edit a schedule' })
  update(@Param('id') id: string, @Body() body: UpdateJobDto): Job {
    return this.jobs.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({ category: 'jobs', action: 'job.delete', title: 'Deleted a bulk job' })
  @ApiOperation({ summary: 'Delete a job or a schedule (cancel a running one first)' })
  remove(@Param('id') id: string): void {
    this.jobs.delete(id);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @LogActivity({ category: 'jobs', action: 'job.pause', title: 'Paused a bulk job' })
  @ApiOperation({ summary: 'Pause at the next object; the checkpoint is kept' })
  pause(@Param('id') id: string): Job {
    return this.jobs.pause(id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @LogActivity({ category: 'jobs', action: 'job.resume', title: 'Resumed a bulk job' })
  @ApiOperation({ summary: 'Continue from the checkpoint' })
  resume(@Param('id') id: string): Job {
    return this.jobs.resume(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @LogActivity({ category: 'jobs', action: 'job.cancel', title: 'Cancelled a bulk job' })
  @ApiOperation({ summary: 'Stop for good; what was done stays done' })
  cancel(@Param('id') id: string): Job {
    return this.jobs.cancel(id);
  }

  @Post(':id/run-now')
  @HttpCode(HttpStatus.OK)
  @LogActivity({ category: 'jobs', action: 'job.run-now', title: 'Ran a bulk job now' })
  @ApiOperation({ summary: 'Fire a schedule now, or run a finished job again' })
  runNow(@Param('id') id: string): Job {
    return this.jobs.runNow(id);
  }

  @Post(':id/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @LogActivity({ category: 'jobs', action: 'job.duplicate', title: 'Duplicated a bulk job' })
  @ApiOperation({ summary: 'Copy the job, optionally as a recurring schedule' })
  duplicate(@Param('id') id: string, @Body() body: DuplicateJobDto): Job {
    return this.jobs.duplicate(id, body);
  }

  @Get(':id/runs')
  @ApiOperation({ summary: 'The runs of a recurring job, newest first' })
  runs(@Param('id') id: string, @Query() query: PaginationQueryDto): JobRunList {
    return this.jobs.runs(id, query);
  }

  @Get(':id/logs')
  @ApiOperation({ summary: 'Log lines after `cursor`, all levels or errors only' })
  logs(@Param('id') id: string, @Query() query: JobLogsQueryDto): JobLogsResponse {
    return this.jobs.logs(id, query);
  }
}
