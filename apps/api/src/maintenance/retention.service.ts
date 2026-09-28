import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ActivityService } from '../activity/activity.service';
import { SessionService } from '../auth/session.service';
import { SettingsService } from '../settings/settings.service';
import { ServerRepository } from '../servers/server.repository';
import { InventoryRepository } from '../modules/inventory/inventory.repository';

/**
 * The housekeeping the architecture asks for: prune the activity log and the
 * metrics per `Settings.retention`, and drop expired sessions.
 *
 * Hourly rather than daily so a long-running install does not accumulate a
 * day's worth of rows to delete in one transaction, and so a retention change
 * takes effect the same day it is made.
 *
 * The job-engine and key-expiry sweeps belong to the tasks that own those
 * tables; this service is the place they go.
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

      if (activityRows + metricRows + sessions > 0) {
        this.logger.log(
          { activityRows, metricRows, sessions },
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
