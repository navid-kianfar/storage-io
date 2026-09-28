import { z } from 'zod';
import { isoDateTime } from './common.js';

export const NOTIFICATION_LEVELS = ['info', 'warning', 'error'] as const;
export const notificationLevelSchema = z.enum(NOTIFICATION_LEVELS);
export type NotificationLevel = z.infer<typeof notificationLevelSchema>;

/** The events the notification rules in `Settings` can be keyed by. */
export const NOTIFICATION_RULE_KEYS = [
  'server.offline',
  'quota.threshold',
  'key.expiring',
  'job.failed',
  'auth.new-device',
] as const;
export const notificationRuleKeySchema = z.enum(NOTIFICATION_RULE_KEYS);
export type NotificationRuleKey = z.infer<typeof notificationRuleKeySchema>;

export const notificationSchema = z.object({
  id: z.string(),
  at: isoDateTime,
  level: notificationLevelSchema,
  title: z.string(),
  detail: z.string(),
  /** Deep link into the UI, e.g. `/servers/minio-lab`. */
  href: z.string().nullable(),
  read: z.boolean(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListSchema = z.object({
  items: z.array(notificationSchema),
  unread: z.number().int().min(0),
});
export type NotificationList = z.infer<typeof notificationListSchema>;

export const listNotificationsQuerySchema = z.object({
  unread: z.stringbool().optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const markNotificationsReadRequestSchema = z.object({
  ids: z.union([z.array(z.string().min(1)), z.literal('all')]),
});
export type MarkNotificationsReadRequest = z.infer<typeof markNotificationsReadRequestSchema>;

/** Channels a notification can be delivered on, besides the in-app list. */
export const NOTIFICATION_CHANNELS = ['email', 'webhook', 'telegram'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

/** What `POST /settings/notifications/test` can exercise — syslog is a sink, not a rule channel. */
export const TESTABLE_CHANNELS = ['email', 'webhook', 'telegram', 'syslog'] as const;
export const testableChannelSchema = z.enum(TESTABLE_CHANNELS);
export type TestableChannel = z.infer<typeof testableChannelSchema>;
