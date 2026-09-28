import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Bucket } from '@storage-io/contracts';
import { ActivityService } from '../../activity/activity.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { ServerRepository } from '../../servers/server.repository';
import { InventoryRepository } from '../inventory/inventory.repository';
import { QuotaRepository, type StoredQuota } from './quota.repository';

/**
 * Raises a notification when a bucket crosses its quota threshold, and exactly
 * once per crossing.
 *
 * "Once per crossing" is the whole design. A quota at 85% of its limit is still at
 * 85% an hour later, and an alert every hour trains the operator to ignore the
 * channel. `quotas.alerted_at` records that the crossing has been reported and is
 * cleared when usage drops back under the threshold, so the next rise alerts again.
 *
 * It runs on a schedule rather than on each upload because the usage figure comes
 * from the inventory cache: a check per request would be a check against a number
 * that had not changed.
 */
@Injectable()
export class QuotaWatcherService {
  private readonly logger = new Logger(QuotaWatcherService.name);

  constructor(
    private readonly quotas: QuotaRepository,
    private readonly inventory: InventoryRepository,
    private readonly servers: ServerRepository,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * Half-hourly. The usage figures come from the inventory cache, whose TTL is five
   * minutes, so a faster sweep would mostly re-read numbers that had not changed.
   */
  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'quota-watcher' })
  sweep(): void {
    try {
      this.check();
    } catch (error) {
      // A failed sweep must not stop the schedule; the next pass retries.
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Quota watcher sweep failed',
      );
    }
  }

  /** Exposed so a test can drive one pass without waiting for the cron. */
  check(): number {
    const all = this.quotas.all();
    if (all.length === 0) return 0;

    let raised = 0;
    for (const quota of all) {
      if (this.evaluate(quota)) raised += 1;
    }
    return raised;
  }

  /* ------------------------------ internals ------------------------ */

  private evaluate(quota: StoredQuota): boolean {
    const bucket = this.inventory.findOne(quota.serverId, quota.bucket);
    if (bucket === null) return false;
    // An offline server's usage is whatever the cache last held; alerting on a
    // stale number would tell the operator a bucket filled up while it was down.
    if (bucket.unavailable) return false;
    if (bucket.sizeBytes === null || quota.limitBytes === 0) return false;

    const ratio = bucket.sizeBytes / quota.limitBytes;
    const crossed = ratio >= quota.threshold;

    if (!crossed) {
      if (quota.alertedAt !== null) this.quotas.clearAlert(quota.serverId, quota.bucket);
      return false;
    }
    if (quota.alertedAt !== null) return false;

    this.raise(quota, bucket, ratio);
    this.quotas.markAlerted(quota.serverId, quota.bucket);
    return true;
  }

  /**
   * Takes the whole `Bucket` rather than its name and size because the link has
   * to carry the bucket's opaque id: `/buckets/<name>` is not a route, and two
   * servers may hold a bucket of the same name. See docs/ROUTES.md.
   */
  private raise(quota: StoredQuota, bucket: Bucket, ratio: number): void {
    const serverName = bucket.serverName;
    const sizeBytes = bucket.sizeBytes ?? 0;
    const percent = Math.round(ratio * 100);
    const thresholdPercent = Math.round(quota.threshold * 100);
    const detail = `${quota.bucket} on ${serverName} is at ${percent}% of its ${formatBytes(quota.limitBytes)} quota (${formatBytes(sizeBytes)} used), past the ${thresholdPercent}% alert threshold.`;

    this.notifications.raise({
      level: percent >= FULL_PERCENT ? 'error' : 'warning',
      title: `${quota.bucket} is at ${percent}% of its quota`,
      detail,
      href: `/buckets/${bucket.id}`,
      ruleKey: 'quota.threshold',
    });

    this.activity.record({
      category: 'buckets',
      action: 'quota.threshold',
      title: `${quota.bucket} crossed its quota threshold`,
      actor: { type: 'system', name: 'quota-watcher' },
      result: 'warning',
      target: quota.bucket,
      serverId: quota.serverId,
      serverName,
      details: {
        bucket: quota.bucket,
        limitBytes: quota.limitBytes,
        sizeBytes,
        threshold: quota.threshold,
        mode: quota.mode,
        native: quota.native,
      },
    });

    this.logger.log(
      { server: serverName, bucket: quota.bucket, percent },
      'Bucket crossed its quota threshold',
    );
  }
}

/* ------------------------------ helpers --------------------------- */

const FULL_PERCENT = 100;
const UNITS: readonly string[] = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const UNIT_STEP = 1000;

/**
 * Decimal units, matching the `Settings.region.sizeUnits` default. This is for a
 * notification sentence, where "500 GB" reads better than the exact byte count the
 * activity `details` keeps.
 */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= UNIT_STEP && unit < UNITS.length - 1) {
    value /= UNIT_STEP;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit] ?? 'B'}`;
}
