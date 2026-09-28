import { z } from 'zod';
import { NOTIFICATION_RULE_KEYS, testableChannelSchema } from './notifications.js';
import { HEALTH_INTERVAL_MAX_SEC, HEALTH_INTERVAL_MIN_SEC } from './servers.js';

/* --------------------------- sub-sections ------------------------- */

export const profileSettingsSchema = z.object({
  displayName: z.string().min(1).max(120),
  email: z.email().max(320).nullable(),
});
export type ProfileSettings = z.infer<typeof profileSettingsSchema>;

/** CIDR or bare address, IPv4 or IPv6 — validated per entry, not as a set. */
export const cidrSchema = z.union([z.cidrv4(), z.cidrv6(), z.ipv4(), z.ipv6()]);

export const securitySettingsSchema = z.object({
  sessionTtlHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365),
  allowedNetworks: z.array(cidrSchema),
});
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;

export const DENSITIES = ['comfortable', 'compact'] as const;
export const appearanceSettingsSchema = z.object({ density: z.enum(DENSITIES) });
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;

export const SIZE_UNITS = ['decimal', 'binary'] as const;
export const CALENDARS = ['auto', 'gregory', 'persian', 'islamic'] as const;
export const DIGIT_MODES = ['auto', 'latn'] as const;
export const WEEK_STARTS = ['auto', 0, 1, 6] as const;

export const regionSettingsSchema = z.object({
  timezone: z.string().min(1).max(64),
  sizeUnits: z.enum(SIZE_UNITS),
  calendar: z.enum(CALENDARS),
  digits: z.enum(DIGIT_MODES),
  weekStart: z.union([z.literal('auto'), z.literal(0), z.literal(1), z.literal(6)]),
});
export type RegionSettings = z.infer<typeof regionSettingsSchema>;

export const PART_SIZES_MB = [8, 16, 64] as const;

export const transferSettingsSchema = z.object({
  parallel: z.number().int().min(1).max(32),
  partSizeMb: z.union([z.literal(8), z.literal(16), z.literal(64)]),
  bandwidthLimitMbps: z.number().int().min(1).nullable(),
  verifyChecksums: z.boolean(),
  keepIncompleteDays: z.number().int().min(0).max(365),
  /** Attempts per part before a transfer gives up; 0 means "try once". */
  retries: z.number().int().min(0).max(10),
  /** Ceiling for `POST …/objects/import-url`, in megabytes. */
  importUrlMaxMb: z
    .number()
    .int()
    .min(1)
    .max(1024 * 1024),
});
export type TransferSettings = z.infer<typeof transferSettingsSchema>;

export const emailSettingsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().max(255),
  /** Write-only: accepted on PATCH, never returned. */
  password: z.string().max(1024).optional(),
  from: z.string().max(320),
  to: z.array(z.email().max(320)),
});
export type EmailSettings = z.infer<typeof emailSettingsSchema>;

export const webhookSettingsSchema = z.object({
  enabled: z.boolean(),
  url: z.string().max(2048),
  /** Write-only: accepted on PATCH, never returned. */
  secret: z.string().max(1024).optional(),
});
export type WebhookSettings = z.infer<typeof webhookSettingsSchema>;

export const telegramSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Write-only: accepted on PATCH, never returned. */
  botToken: z.string().max(1024).optional(),
  chatId: z.string().max(64),
});
export type TelegramSettings = z.infer<typeof telegramSettingsSchema>;

export const notificationRuleSchema = z.object({
  inApp: z.boolean(),
  email: z.boolean(),
  webhook: z.boolean(),
  telegram: z.boolean(),
});
export type NotificationRule = z.infer<typeof notificationRuleSchema>;

export const notificationRulesSchema = z.object(
  Object.fromEntries(NOTIFICATION_RULE_KEYS.map((key) => [key, notificationRuleSchema])) as Record<
    (typeof NOTIFICATION_RULE_KEYS)[number],
    typeof notificationRuleSchema
  >,
);
export type NotificationRules = z.infer<typeof notificationRulesSchema>;

export const notificationSettingsSchema = z.object({
  email: emailSettingsSchema,
  webhook: webhookSettingsSchema,
  telegram: telegramSettingsSchema,
  rules: notificationRulesSchema,
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const SYSLOG_PROTOCOLS = ['udp', 'tcp', 'tls'] as const;
export const SYSLOG_FORMATS = ['rfc5424', 'json'] as const;

/** Forward the activity log to a syslog collector as well as storing it. */
export const syslogSettingsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().max(255),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(SYSLOG_PROTOCOLS),
  format: z.enum(SYSLOG_FORMATS),
  facility: z.number().int().min(0).max(23),
});
export type SyslogSettings = z.infer<typeof syslogSettingsSchema>;

export const activitySettingsSchema = z.object({ syslog: syslogSettingsSchema });
export type ActivitySettings = z.infer<typeof activitySettingsSchema>;

export const retentionSettingsSchema = z.object({
  activityDays: z.number().int().min(1).max(3650),
  metricsDays: z.number().int().min(1).max(3650),
});
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;

export const healthSettingsSchema = z.object({
  defaultIntervalSec: z.number().int().min(HEALTH_INTERVAL_MIN_SEC).max(HEALTH_INTERVAL_MAX_SEC),
  latencyWarnMs: z.number().int().min(1).max(60_000),
});
export type HealthSettings = z.infer<typeof healthSettingsSchema>;

/* ------------------------------ settings -------------------------- */

export const settingsSchema = z.object({
  profile: profileSettingsSchema,
  security: securitySettingsSchema,
  appearance: appearanceSettingsSchema,
  region: regionSettingsSchema,
  transfers: transferSettingsSchema,
  notifications: notificationSettingsSchema,
  activity: activitySettingsSchema,
  retention: retentionSettingsSchema,
  health: healthSettingsSchema,
});
export type Settings = z.infer<typeof settingsSchema>;

/**
 * PATCH /settings accepts a partial tree, one level deep per section, so a
 * client can send `{ health: { latencyWarnMs: 800 } }` without resending the
 * rest.
 */
export const updateSettingsRequestSchema = z
  .object({
    profile: profileSettingsSchema.partial().optional(),
    security: securitySettingsSchema.partial().optional(),
    appearance: appearanceSettingsSchema.partial().optional(),
    region: regionSettingsSchema.partial().optional(),
    transfers: transferSettingsSchema.partial().optional(),
    notifications: z
      .object({
        email: emailSettingsSchema.partial().optional(),
        webhook: webhookSettingsSchema.partial().optional(),
        telegram: telegramSettingsSchema.partial().optional(),
        rules: notificationRulesSchema.partial().optional(),
      })
      .optional(),
    activity: z.object({ syslog: syslogSettingsSchema.partial().optional() }).optional(),
    retention: retentionSettingsSchema.partial().optional(),
    health: healthSettingsSchema.partial().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one section is required' });
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

/** Every field the API falls back to on a fresh database. */
export const SETTINGS_DEFAULTS: Settings = {
  profile: { displayName: 'Administrator', email: null },
  security: { sessionTtlHours: 12, allowedNetworks: [] },
  appearance: { density: 'comfortable' },
  region: {
    timezone: 'UTC',
    // Decimal (kB, MB, GB) by default: it matches what storage providers bill
    // and report, which is the number an operator is reconciling against.
    sizeUnits: 'decimal',
    calendar: 'auto',
    digits: 'auto',
    weekStart: 'auto',
  },
  transfers: {
    parallel: 4,
    partSizeMb: 16,
    bandwidthLimitMbps: null,
    verifyChecksums: true,
    keepIncompleteDays: 7,
    retries: 4,
    importUrlMaxMb: 2048,
  },
  notifications: {
    email: { enabled: false, host: '', port: 587, secure: true, username: '', from: '', to: [] },
    webhook: { enabled: false, url: '' },
    telegram: { enabled: false, chatId: '' },
    rules: {
      'server.offline': { inApp: true, email: false, webhook: false, telegram: false },
      'quota.threshold': { inApp: true, email: false, webhook: false, telegram: false },
      'key.expiring': { inApp: true, email: false, webhook: false, telegram: false },
      'job.failed': { inApp: true, email: false, webhook: false, telegram: false },
      'auth.new-device': { inApp: true, email: false, webhook: false, telegram: false },
    },
  },
  activity: {
    syslog: {
      enabled: false,
      host: '',
      port: 514,
      protocol: 'udp',
      format: 'rfc5424',
      facility: 1,
    },
  },
  retention: { activityDays: 90, metricsDays: 365 },
  health: { defaultIntervalSec: 30, latencyWarnMs: 500 },
};

/* ------------------------- test / export / import ----------------- */

export const testNotificationRequestSchema = z.object({ channel: testableChannelSchema });
export type TestNotificationRequest = z.infer<typeof testNotificationRequestSchema>;

export const testNotificationResponseSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
});
export type TestNotificationResponse = z.infer<typeof testNotificationResponseSchema>;

export const exportSettingsRequestSchema = z.object({
  passphrase: z.string().min(8).max(1024),
});
export type ExportSettingsRequest = z.infer<typeof exportSettingsRequestSchema>;

export const importSettingsResponseSchema = z.object({
  servers: z.number().int().min(0),
  settings: z.boolean(),
});
export type ImportSettingsResponse = z.infer<typeof importSettingsResponseSchema>;
