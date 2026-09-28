import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ActivityService } from '../activity/activity.service';
import { SessionService } from '../auth/session.service';
import { SettingsService } from '../settings/settings.service';
import { ServerRepository } from '../servers/server.repository';
import { InventoryRepository } from '../modules/inventory/inventory.repository';
import { JobsRepository } from '../modules/jobs/jobs.repository';

/**
 * The housekeeping the architecture asks for: prune the activity log and the
 * metrics per `Settings.retention`, and drop expired sessions.
 *
 * Hourly rather than daily so a long-running install does not accumulate a
 * day's worth of rows to delete in one transaction, and so a retention change
 * takes effect the same day it is made.
 *
 * Finished job runs (and, through the schema's cascade, their log lines) are pruned
 * on the activity budget: they are the same kind of history, and an operator keeping
 * 90 days of one means 90 days of the other. Recurring schedules are configuration
 * and are never pruned.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly activity: ActivityService,
    private readonly servers: ServerRepository,
    private readonly sessions: SessionService,
    private readonly inventory: InventoryRepository,
    private readonly jobs: JobsRepository,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'retention' })
  sweep(): void {
    const { retention } = this.settings.getInternal();

    try {
      const activityRows = this.activity.deleteOlderThan(retention.activityDays);
      const metricRows =
        this.servers.deleteMetricsOlderThan(retention.metricsDays) +
        // Daily bucket sizes are a metric series like the others, and the quota
        // trend only ever reads the last week of them.
        this.inventory.deleteSamplesOlderThan(retention.metricsDays);
      const sessions = this.sessions.deleteExpired();
      // Finished job runs and their logs are history like the activity trail, and
      // an operator who keeps 90 days of one wants 90 days of the other — so they
      // share `activityDays` rather than gaining a setting nobody would tune
      // separately. A schedule is configuration, not history, and is never pruned.
      const jobRows = this.jobs.pruneFinishedOlderThan(retention.activityDays);

      if (activityRows + metricRows + sessions + jobRows > 0) {
        this.logger.log(
          { activityRows, metricRows, sessions, jobRows },
          'Retention sweep removed expired rows',
        );
      }
    } catch (error) {
      // A failed sweep must not stop the schedule; the next hour retries.
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Retention sweep failed',
      );
    }
  }
}
