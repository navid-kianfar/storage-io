import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import {
  type Notification,
  type NotificationLevel,
  type NotificationList,
  type NotificationRuleKey,
  type TestableChannel,
} from '@storage-io/contracts';
import { DB } from '../db/db.module';
import type { AppDatabase } from '../db/migrate';
import { notificationDedup, notifications } from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import { EventBusService } from '../events/event-bus.service';
import { SettingsService } from '../settings/settings.service';
import {
  NOTIFICATION_CHANNELS,
  type DeliveryResult,
  type NotificationChannelDriver,
} from './delivery/notification-channel';

/** Distinguishes "suppressed" from "zero previous repeats". */
const SUPPRESSED = Symbol('SUPPRESSED');

const LIST_LIMIT = 200;

/**
 * How long the same fingerprint stays quiet. Fifteen minutes is the compromise
 * the alternatives make badly: a shorter window mails an operator every health
 * tick while a server is down, and a longer one hides a second outage inside the
 * first one's silence.
 */
export const DEFAULT_DEDUP_WINDOW_SEC = 15 * 60;

export interface RaiseNotificationInput {
  readonly level: NotificationLevel;
  readonly title: string;
  readonly detail: string;
  readonly href?: string | null;
  /** Which rule row decides the channels. Omit for a notification with no rule. */
  readonly ruleKey?: NotificationRuleKey | null;
  /**
   * The caller's identity for this alert — rule key plus the thing it is about,
   * e.g. `server.offline:minio-lab`. Two raises with the same fingerprint inside
   * `dedupWindowSec` produce one notification, and the next one that gets through
   * says how many were folded into it.
   *
   * Omit it for news that is new every time (a job finishing, a key created).
   */
  readonly fingerprint?: string;
  /** Defaults to `DEFAULT_DEDUP_WINDOW_SEC`. */
  readonly dedupWindowSec?: number;
}

/**
 * Raises notifications and fans them out. The in-app list is stored here; the
 * external channels are drivers behind `NotificationChannelDriver`, which a later
 * task implements without touching this file.
 *
 * A delivery failure never propagates: the caller is usually the health checker
 * or the job engine, and a dead SMTP server must not fail the thing that
 * noticed the problem.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(NOTIFICATION_CHANNELS)
    private readonly channels: readonly NotificationChannelDriver[],
    private readonly crypto: CryptoService,
    private readonly settings: SettingsService,
    private readonly bus: EventBusService,
  ) {}

  /**
   * Stores the notification, pushes it over SSE, then attempts each channel.
   *
   * Returns `null` when a fingerprint suppressed it — the caller does not need to
   * know, but a test does, and so does anything that would otherwise log "raised"
   * for something nobody saw.
   */
  raise(input: RaiseNotificationInput): Notification | null {
    const suppressedCount = this.checkDedup(input);
    if (suppressedCount === SUPPRESSED) return null;

    const settings = this.settings.getInternal();
    const rule =
      input.ruleKey === undefined || input.ruleKey === null
        ? null
        : settings.notifications.rules[input.ruleKey];

    const notification: Notification = {
      id: this.crypto.newId(),
      at: new Date().toISOString(),
      level: input.level,
      title: input.title,
      detail:
        suppressedCount === 0
          ? input.detail
          : `${input.detail} (${suppressedCount} repeat${suppressedCount === 1 ? '' : 's'} suppressed since the last alert)`,
      href: input.href ?? null,
      read: false,
    };

    // `inApp: false` means the operator asked not to see it in the app, but the
    // record is still worth keeping — it is marked read so it does not nag.
    const showInApp = rule === null || rule.inApp;

    this.db
      .insert(notifications)
      .values({ ...notification, read: !showInApp, ruleKey: input.ruleKey ?? null })
      .run();

    if (showInApp) {
      this.bus.publish('notification', { notification, unread: this.unreadCount() });
    }

    void this.fanOut(notification, input.ruleKey ?? null);
    return notification;
  }

  list(unreadOnly: boolean): NotificationList {
    const where = unreadOnly ? eq(notifications.read, false) : undefined;
    const rows = this.db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.at))
      .limit(LIST_LIMIT)
      .all();

    return {
      items: rows.map((row): Notification => ({
        id: row.id,
        at: row.at,
        level: row.level as NotificationLevel,
        title: row.title,
        detail: row.detail,
        href: row.href,
        read: row.read,
      })),
      unread: this.unreadCount(),
    };
  }

  /** `'all'` or an explicit id list; either way it is one UPDATE. */
  markRead(ids: readonly string[] | 'all'): number {
    if (ids === 'all') {
      const result = this.db
        .update(notifications)
        .set({ read: true })
        .where(eq(notifications.read, false))
        .run();
      return result.changes;
    }

    if (ids.length === 0) return 0;
    const result = this.db
      .update(notifications)
      .set({ read: true })
      .where(and(inArray(notifications.id, [...ids]), eq(notifications.read, false)))
      .run();
    return result.changes;
  }

  /**
   * `SUPPRESSED` when this fingerprint fired recently; otherwise the number of
   * raises that were folded into this one, which goes into the detail so nothing
   * is silently dropped.
   *
   * One upsert either way: reading and then writing would let two callers past the
   * window in the same millisecond.
   */
  private checkDedup(input: RaiseNotificationInput): number | typeof SUPPRESSED {
    const fingerprint = input.fingerprint;
    if (fingerprint === undefined) return 0;

    const windowSec = input.dedupWindowSec ?? DEFAULT_DEDUP_WINDOW_SEC;
    const now = new Date();
    const nowIso = now.toISOString();
    const [existing] = this.db
      .select()
      .from(notificationDedup)
      .where(eq(notificationDedup.fingerprint, fingerprint))
      .limit(1)
      .all();

    const withinWindow =
      existing !== undefined &&
      now.getTime() - Date.parse(existing.lastRaisedAt) < windowSec * 1000;

    if (withinWindow) {
      this.db
        .update(notificationDedup)
        .set({ suppressed: existing.suppressed + 1 })
        .where(eq(notificationDedup.fingerprint, fingerprint))
        .run();
      return SUPPRESSED;
    }

    const suppressed = existing?.suppressed ?? 0;
    this.db
      .insert(notificationDedup)
      .values({ fingerprint, lastRaisedAt: nowIso, suppressed: 0 })
      .onConflictDoUpdate({
        target: notificationDedup.fingerprint,
        set: { lastRaisedAt: nowIso, suppressed: 0 },
      })
      .run();
    return suppressed;
  }

  unreadCount(): number {
    const [row] = this.db
      .select({ total: count() })
      .from(notifications)
      .where(eq(notifications.read, false))
      .all();
    return row?.total ?? 0;
  }

  /** Forgets a fingerprint, so the next alert about it is raised immediately. */
  clearDedup(fingerprint: string): void {
    this.db.delete(notificationDedup).where(eq(notificationDedup.fingerprint, fingerprint)).run();
  }

  /** `POST /settings/notifications/test`. Uses the stored settings. */
  async test(channel: TestableChannel): Promise<DeliveryResult> {
    const driver = this.channels.find((candidate) => candidate.channel === channel);
    if (driver === undefined) {
      return { ok: false, detail: `No driver for the ${channel} channel.` };
    }

    const settings = this.settings.getInternal();
    if (!driver.isEnabled(settings)) {
      return { ok: false, detail: `The ${channel} channel is disabled in settings.` };
    }

    try {
      return await driver.test(settings);
    } catch (error) {
      this.logger.error({ err: error, channel }, 'Notification channel test threw');
      return { ok: false, detail: `The ${channel} test failed. See the server log.` };
    }
  }

  /**
   * Deliberately not awaited by `raise`: delivery is best-effort and must not
   * hold up the caller. Every failure is logged, so nothing is swallowed.
   */
  private async fanOut(
    notification: Notification,
    ruleKey: NotificationRuleKey | null,
  ): Promise<void> {
    const settings = this.settings.getInternal();
    const rule = ruleKey === null ? null : settings.notifications.rules[ruleKey];

    for (const driver of this.channels) {
      if (driver.channel === 'syslog') continue; // syslog carries activity, not notifications
      if (!driver.isEnabled(settings)) continue;
      if (rule !== null && rule[driver.channel] !== true) continue;

      try {
        const result = await driver.deliver(notification, settings);
        if (!result.ok) {
          this.logger.warn(
            { channel: driver.channel, detail: result.detail, notificationId: notification.id },
            'Notification delivery failed',
          );
        }
      } catch (error) {
        this.logger.error({ err: error, channel: driver.channel }, 'Notification channel threw');
      }
    }
  }
}
