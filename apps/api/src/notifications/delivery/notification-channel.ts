import type { Notification, NotificationChannel, Settings } from '@storage-io/contracts';

/**
 * The contract a delivery channel implements. Email, webhook and Telegram
 * transports are a later task; this interface and the registry below are what
 * that task plugs into, so nothing outside `delivery/` has to change.
 *
 * Design notes for whoever implements a channel:
 *
 * - `deliver` must not throw. A dead SMTP host cannot be allowed to fail the
 *   health check that raised the notification, so the result is returned rather
 *   than raised, and `NotificationService` logs it.
 * - `test` is what `POST /settings/notifications/test` calls. It uses the
 *   settings passed in, not the stored ones, so an operator can verify a change
 *   before saving it.
 * - Secrets arrive already decrypted in `settings`; a channel never reads the
 *   database or `process.env` itself.
 */
export interface NotificationChannelDriver {
  readonly channel: NotificationChannel | 'syslog';

  /** True when the operator has configured and enabled this channel. */
  isEnabled(settings: Settings): boolean;

  deliver(notification: Notification, settings: Settings): Promise<DeliveryResult>;

  /** A deliberate probe: send something harmless and report what happened. */
  test(settings: Settings): Promise<DeliveryResult>;
}

export interface DeliveryResult {
  readonly ok: boolean;
  /** Safe to show an operator: no stack trace, no credential, no internal host. */
  readonly detail: string;
}

export const DELIVERY_NOT_IMPLEMENTED = (channel: string): DeliveryResult => ({
  ok: false,
  detail: `The ${channel} channel is not implemented yet.`,
});

/** DI token for the array of channel drivers. */
export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

/**
 * A placeholder driver per channel, so the routing logic, the settings matrix
 * and the test endpoint are all exercised today and the later task only replaces
 * the body of `deliver`/`test`.
 */
export class UnimplementedChannel implements NotificationChannelDriver {
  constructor(
    readonly channel: NotificationChannel | 'syslog',
    private readonly enabledIn: (settings: Settings) => boolean,
  ) {}

  isEnabled(settings: Settings): boolean {
    return this.enabledIn(settings);
  }

  deliver(): Promise<DeliveryResult> {
    return Promise.resolve(DELIVERY_NOT_IMPLEMENTED(this.channel));
  }

  test(): Promise<DeliveryResult> {
    return Promise.resolve(DELIVERY_NOT_IMPLEMENTED(this.channel));
  }
}

export const defaultChannels = (): readonly NotificationChannelDriver[] => [
  new UnimplementedChannel('email', (settings) => settings.notifications.email.enabled),
  new UnimplementedChannel('webhook', (settings) => settings.notifications.webhook.enabled),
  new UnimplementedChannel('telegram', (settings) => settings.notifications.telegram.enabled),
  new UnimplementedChannel('syslog', (settings) => settings.activity.syslog.enabled),
];
