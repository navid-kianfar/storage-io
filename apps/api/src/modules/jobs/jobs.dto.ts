import {
  createJobRequestSchema,
  duplicateJobRequestSchema,
  estimateJobRequestSchema,
  jobLogsQuerySchema,
  listJobsQuerySchema,
  paginationQuerySchema,
  updateJobRequestSchema,
} from '@storage-io/contracts';
import { dtoFrom } from '../../common/dto';

/** Every shape `/jobs` accepts, straight from the contract — no field is restated. */
export class CreateJobDto extends dtoFrom(createJobRequestSchema) {}
export class UpdateJobDto extends dtoFrom(updateJobRequestSchema) {}
export class DuplicateJobDto extends dtoFrom(duplicateJobRequestSchema) {}
export class EstimateJobDto extends dtoFrom(estimateJobRequestSchema) {}
export class JobLogsQueryDto extends dtoFrom(jobLogsQuerySchema) {}

/** `?view` and `?page` arrive together, so they are validated together. */
export class ListJobsQueryDto extends dtoFrom(listJobsQuerySchema.merge(paginationQuerySchema)) {}
export class PaginationQueryDto extends dtoFrom(paginationQuerySchema) {}
