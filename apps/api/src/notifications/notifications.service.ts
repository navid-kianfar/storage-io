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
import { notifications } from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import { EventBusService } from '../events/event-bus.service';
import { SettingsService } from '../settings/settings.service';
import {
  NOTIFICATION_CHANNELS,
  type DeliveryResult,
  type NotificationChannelDriver,
} from './delivery/notification-channel';

const LIST_LIMIT = 200;

export interface RaiseNotificationInput {
  readonly level: NotificationLevel;
  readonly title: string;
  readonly detail: string;
  readonly href?: string | null;
  /** Which rule row decides the channels. Omit for a notification with no rule. */
  readonly ruleKey?: NotificationRuleKey | null;
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

  /** Stores the notification, pushes it over SSE, then attempts each channel. */
  raise(input: RaiseNotificationInput): Notification {
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
      detail: input.detail,
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

  unreadCount(): number {
    const [row] = this.db
      .select({ total: count() })
      .from(notifications)
      .where(eq(notifications.read, false))
      .all();
    return row?.total ?? 0;
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
