import { createHmac, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import type { Notification, Settings } from '@storage-io/contracts';
import { sendSyslog } from './syslog';
import { type DeliveryResult, type NotificationChannelDriver } from './notification-channel';

/**
 * The real transports behind `Settings.notifications`.
 *
 * Three rules hold in all of them, and they are why this file looks defensive:
 *
 * 1. **`deliver` never throws.** The callers are the health checker and the job
 *    engine. A dead SMTP host must not fail the thing that noticed the problem, so
 *    every failure comes back as `{ ok: false, detail }` and the service logs it.
 * 2. **The detail is safe to show an operator.** A transport error carries the
 *    remote host, sometimes a certificate chain, occasionally a credential the
 *    library echoed back. Only a short reason crosses the boundary; the full error
 *    goes to the log.
 * 3. **Nothing is retried here.** A notification is news, not a task: a retry
 *    queue would mean a second store and a second sweep, and an alert that
 *    arrives ten minutes late is worse than one that is missing from a channel the
 *    operator can see is broken. The in-app row is always written, so nothing is
 *    lost.
 */

const log = new Logger('NotificationChannels');

/** Long enough for a slow SMTP handshake, short enough not to stall a sweep. */
const SMTP_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 8_000;
const TELEGRAM_API = 'https://api.telegram.org';

/* -------------------------------- email ---------------------------- */

/**
 * SMTP through nodemailer.
 *
 * A transport per delivery rather than a pooled one: settings can change between
 * two notifications, and a pool keyed on the settings would have to be invalidated
 * from the settings service — a coupling that buys nothing at a few messages an
 * hour.
 *
 * `secure` is the operator's choice because it is not inferable: 465 is implicit
 * TLS, 587 is STARTTLS, and a host that only offers one will refuse the other.
 */
export class EmailChannel implements NotificationChannelDriver {
  readonly channel = 'email' as const;

  isEnabled(settings: Settings): boolean {
    const email = settings.notifications.email;
    return email.enabled && email.host.length > 0 && email.to.length > 0;
  }

  async deliver(notification: Notification, settings: Settings): Promise<DeliveryResult> {
    const subject = `[storage-io] ${notification.title}`;
    const text = [
      notification.title,
      '',
      notification.detail,
      '',
      `Level: ${notification.level}`,
      `At: ${notification.at}`,
      ...(notification.href === null ? [] : [`Link: ${notification.href}`]),
    ].join('\n');

    return this.send(settings, subject, text);
  }

  async test(settings: Settings): Promise<DeliveryResult> {
    return this.send(
      settings,
      '[storage-io] Test message',
      'This is a test message from storage-io. If you can read it, the SMTP settings work.',
    );
  }

  private async send(settings: Settings, subject: string, text: string): Promise<DeliveryResult> {
    const email = settings.notifications.email;
    if (email.host.length === 0) return { ok: false, detail: 'No SMTP host is configured.' };
    if (email.to.length === 0) return { ok: false, detail: 'No recipients are configured.' };

    const transport = createTransport({
      host: email.host,
      port: email.port,
      secure: email.secure,
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
      // An empty username means an open relay on the local network, which is a
      // normal on-premise setup; passing empty credentials would make nodemailer
      // attempt AUTH and fail.
      ...(email.username.length === 0
        ? {}
        : { auth: { user: email.username, pass: email.password ?? '' } }),
    });

    try {
      const from = email.from.length > 0 ? email.from : email.username;
      const info = await transport.sendMail({ from, to: [...email.to], subject, text });
      return {
        ok: true,
        detail: `Accepted by ${email.host} (${info.accepted.length} recipient(s)).`,
      };
    } catch (error) {
      log.warn({ err: describe(error), host: email.host }, 'SMTP delivery failed');
      return { ok: false, detail: `${email.host} refused the message (${shortReason(error)}).` };
    } finally {
      transport.close();
    }
  }
}

/* ------------------------------- webhook --------------------------- */

export const WEBHOOK_SIGNATURE_HEADER = 'x-storage-io-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-storage-io-timestamp';
export const WEBHOOK_EVENT_HEADER = 'x-storage-io-event';

/**
 * A JSON POST, signed so the receiver can tell a storage-io notification from
 * anything else that found the URL.
 *
 * The signature is `HMAC-SHA256(secret, "<timestamp>.<body>")`, hex, in
 * `x-storage-io-signature`, with the same timestamp in its own header. Signing the
 * timestamp together with the body is what makes a captured request unreplayable:
 * a receiver that checks the age and then the signature cannot be fed yesterday's
 * valid payload.
 *
 * Without a secret the request still goes, unsigned — an operator posting to a
 * URL on their own network should not be forced to configure one — and the absence
 * of the header is the receiver's signal.
 */
export class WebhookChannel implements NotificationChannelDriver {
  readonly channel = 'webhook' as const;

  isEnabled(settings: Settings): boolean {
    const webhook = settings.notifications.webhook;
    return webhook.enabled && webhook.url.length > 0;
  }

  async deliver(notification: Notification, settings: Settings): Promise<DeliveryResult> {
    return this.post(settings, 'notification', {
      id: notification.id,
      at: notification.at,
      level: notification.level,
      title: notification.title,
      detail: notification.detail,
      href: notification.href,
    });
  }

  async test(settings: Settings): Promise<DeliveryResult> {
    return this.post(settings, 'test', {
      at: new Date().toISOString(),
      message: 'This is a test webhook from storage-io.',
    });
  }

  private async post(
    settings: Settings,
    event: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<DeliveryResult> {
    const webhook = settings.notifications.webhook;
    if (webhook.url.length === 0) return { ok: false, detail: 'No webhook URL is configured.' };

    const target = parseHttpUrl(webhook.url);
    if (target === null) {
      return { ok: false, detail: 'The webhook URL must be an http:// or https:// URL.' };
    }

    const body = JSON.stringify({ event, data: payload });
    const timestamp = String(Date.now());
    const secret = webhook.secret ?? '';

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'storage-io',
      [WEBHOOK_EVENT_HEADER]: event,
      [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    };
    if (secret.length > 0) {
      headers[WEBHOOK_SIGNATURE_HEADER] = signWebhook(secret, timestamp, body);
    }

    try {
      const response = await fetch(target, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!response.ok) {
        return { ok: false, detail: `The endpoint answered HTTP ${response.status}.` };
      }
      return { ok: true, detail: `The endpoint answered HTTP ${response.status}.` };
    } catch (error) {
      log.warn({ err: describe(error), host: target.host }, 'Webhook delivery failed');
      return { ok: false, detail: `Could not reach ${target.host} (${shortReason(error)}).` };
    }
  }
}

/** `HMAC-SHA256(secret, "<timestamp>.<body>")`, hex. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** What a receiver does; exported so the test asserts the real comparison. */
export function verifyWebhook(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signWebhook(secret, timestamp, body), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/* ------------------------------- telegram -------------------------- */

/**
 * Telegram's Bot API `sendMessage`.
 *
 * Plain text, not Markdown or HTML: a bucket name with an underscore in it breaks
 * Markdown parsing and Telegram answers 400, so the one place the message could
 * fail because of its *content* is removed by not asking for formatting.
 */
export class TelegramChannel implements NotificationChannelDriver {
  readonly channel = 'telegram' as const;

  isEnabled(settings: Settings): boolean {
    const telegram = settings.notifications.telegram;
    return telegram.enabled && telegram.chatId.length > 0;
  }

  async deliver(notification: Notification, settings: Settings): Promise<DeliveryResult> {
    const lines = [
      `${levelPrefix(notification.level)} ${notification.title}`,
      notification.detail,
      ...(notification.href === null ? [] : [notification.href]),
    ];
    return this.send(settings, lines.join('\n'));
  }

  async test(settings: Settings): Promise<DeliveryResult> {
    return this.send(settings, 'storage-io test message. If you can read this, the bot works.');
  }

  private async send(settings: Settings, text: string): Promise<DeliveryResult> {
    const telegram = settings.notifications.telegram;
    const token = telegram.botToken ?? '';
    if (token.length === 0) return { ok: false, detail: 'No Telegram bot token is configured.' };
    if (telegram.chatId.length === 0)
      return { ok: false, detail: 'No Telegram chat id is configured.' };

    try {
      const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegram.chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });

      const parsed = (await response.json().catch(() => null)) as TelegramReply | null;
      if (response.ok && parsed?.ok === true) {
        return { ok: true, detail: 'Telegram accepted the message.' };
      }
      // Telegram's own description is operator-facing ("chat not found", "Unauthorized")
      // and carries no secret, so it is worth passing on.
      const description = parsed?.description ?? `HTTP ${response.status}`;
      return { ok: false, detail: `Telegram refused the message: ${description}.` };
    } catch (error) {
      log.warn({ err: describe(error) }, 'Telegram delivery failed');
      return { ok: false, detail: `Could not reach the Telegram API (${shortReason(error)}).` };
    }
  }
}

interface TelegramReply {
  readonly ok?: boolean;
  readonly description?: string;
}

/* -------------------------------- syslog --------------------------- */

/**
 * Syslog is in the channel list for the test endpoint only: it carries the
 * activity log, not notifications, and `NotificationsService.fanOut` skips it.
 * `ActivitySyslogForwarder` is what actually writes to it.
 */
export class SyslogChannel implements NotificationChannelDriver {
  readonly channel = 'syslog' as const;

  isEnabled(settings: Settings): boolean {
    const syslog = settings.activity.syslog;
    return syslog.enabled && syslog.host.length > 0;
  }

  deliver(): Promise<DeliveryResult> {
    return Promise.resolve({
      ok: true,
      detail: 'Syslog carries the activity log, not notifications.',
    });
  }

  async test(settings: Settings): Promise<DeliveryResult> {
    return sendSyslog(settings.activity.syslog, {
      severity: 'notice',
      msgId: 'settings.notifications.test',
      payload: { message: 'storage-io syslog test' },
    });
  }
}

/* ------------------------------ the registry ----------------------- */

export const realChannels = (): readonly NotificationChannelDriver[] => [
  new EmailChannel(),
  new WebhookChannel(),
  new TelegramChannel(),
  new SyslogChannel(),
];

/* ------------------------------ helpers --------------------------- */

const levelPrefix = (level: Notification['level']): string => {
  switch (level) {
    case 'error':
      return '[ERROR]';
    case 'warning':
      return '[WARN]';
    case 'info':
      return '[INFO]';
  }
};

/** Only http(s), and never a URL with credentials in it. */
function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username.length > 0 || url.password.length > 0) return null;
    return url;
  } catch {
    return null;
  }
}

/** For the log: the whole message, which may name a host or a certificate. */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** For an operator: a code or a short phrase, never a chain or a stack. */
function shortReason(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown error';
  const shape = error as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof shape.code === 'string') return shape.code;
  if (shape.name === 'TimeoutError' || shape.name === 'AbortError') return 'timed out';
  if (typeof shape.message === 'string') return shape.message.slice(0, 80);
  return 'unknown error';
}
