import { Module } from '@nestjs/common';
import { ServersModule } from '../../servers/servers.module';
import { StorageModule } from '../storage/storage.module';
import { JOBS_PORT } from './jobs.port';
import { JobsController } from './jobs.controller';
import { JobsRepository } from './jobs.repository';
import { JobsService } from './jobs.service';
import { JobActionsService } from './job-actions.service';
import { JobEngineService } from './job-engine.service';
import { JobEstimatorService } from './job-estimator.service';
import { JobSchedulerService } from './job-scheduler.service';
import { JobSourceService } from './job-source.service';

/**
 * The bulk-job engine: the `/jobs` endpoints, the runner, the scheduler and the
 * `JOBS_PORT` the buckets and objects modules enqueue through.
 *
 * `JOBS_PORT` still resolves to a service with the same `enqueue` signature wave
 * 2a's callers were written against — that is the whole point of the token, and it
 * is why replacing the enqueue-only implementation with the real engine touched no
 * file outside this folder.
 *
 * **It imports `StorageModule`, not `ObjectsModule`.** Objects already imports
 * this module for `JOBS_PORT`, so depending on it back would be a cycle; the S3
 * calls a job makes live in `JobActionsService` instead. Everything else the engine
 * needs — settings, activity, notifications, the event bus — is `@Global()`.
 */
@Module({
  imports: [ServersModule, StorageModule],
  controllers: [JobsController],
  providers: [
    JobsRepository,
    JobSourceService,
    JobActionsService,
    JobEstimatorService,
    JobEngineService,
    JobsService,
    JobSchedulerService,
    { provide: JOBS_PORT, useExisting: JobsService },
  ],
  exports: [JOBS_PORT, JobsRepository, JobsService, JobEngineService, JobSchedulerService],
})
export class JobsModule {}
