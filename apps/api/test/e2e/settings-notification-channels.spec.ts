import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DB } from '../../src/db/db.module';
import type { AppDatabase } from '../../src/db/migrate';
import { settings as settingsTable } from '../../src/db/schema';
import { SettingsService } from '../../src/settings/settings.service';
import { createTestApp, type TestHarness } from '../support/test-app';

/**
 * Disconnecting a delivery channel.
 *
 * A PATCH cannot express this: the merge keeps every key the caller omits, so an
 * omitted secret means "keep the stored one" and there is no body that removes a
 * saved password. `DELETE /settings/notifications/:channel` is the verb that can,
 * and these cases hold it to the part that is easy to get wrong — the write-only
 * secret really leaving the database, and the rules column going with it.
 */

const WEBHOOK_URL = 'https://hooks.example.invalid/storage-io';
const WEBHOOK_SECRET = 'webhook-s3cret-should-not-survive-removal';
const SMTP_PASSWORD = 'smtp-p4ssw0rd-should-not-survive-removal';
const BOT_TOKEN = '123456:bot-token-should-not-survive-removal';

describe('disconnect a notification channel (e2e)', () => {
  let harness: TestHarness | null = null;

  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  const storedNotifications = (app: TestHarness): Record<string, unknown> => {
    const db = app.app.get<AppDatabase>(DB);
    const [row] = db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.section, 'notifications'))
      .limit(1)
      .all();
    if (row === undefined) throw new Error('No notifications row was written.');
    return row.value;
  };

  it('clears the webhook, its secret and every rule that routed to it', async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    const cookie = await harness.login();

    await harness
      .http()
      .patch('/api/v1/settings')
      .set({ Cookie: cookie, Origin: harness.origin })
      .send({
        notifications: {
          webhook: { enabled: true, url: WEBHOOK_URL, secret: WEBHOOK_SECRET },
          rules: { 'server.offline': { inApp: true, email: false, webhook: true, telegram: false } },
        },
      })
      .expect(200);

    const configured = harness.app.get(SettingsService).getInternal().notifications;
    expect(configured.webhook.secret).toBe(WEBHOOK_SECRET);

    const response = await harness
      .http()
      .delete('/api/v1/settings/notifications/webhook')
      .set({ Cookie: cookie, Origin: harness.origin })
      .expect(200);

    // The response is the whole document, with the channel back at its defaults.
    expect(response.body.notifications.webhook).toEqual({ enabled: false, url: '' });
    expect(response.body.notifications.rules['server.offline'].webhook).toBe(false);
    // The in-app tick on that rule is untouched: only the one column is cleared.
    expect(response.body.notifications.rules['server.offline'].inApp).toBe(true);

    // The secret is gone from the database, not merely hidden on the wire.
    const raw = JSON.stringify(storedNotifications(harness));
    expect(raw).not.toContain(WEBHOOK_SECRET);
    expect(raw).not.toContain(WEBHOOK_URL);

    // And gone from the value the delivery driver reads, across a cache drop.
    const service = harness.app.get(SettingsService);
    service.invalidate();
    const internal = service.getInternal().notifications;
    expect(internal.webhook.secret).toBeUndefined();
    expect(internal.webhook.url).toBe('');
    expect(internal.webhook.enabled).toBe(false);
  });

  it('leaves the other channels and their secrets alone', async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    const cookie = await harness.login();

    await harness
      .http()
      .patch('/api/v1/settings')
      .set({ Cookie: cookie, Origin: harness.origin })
      .send({
        notifications: {
          email: { enabled: true, host: 'smtp.example.invalid', from: 'a@b.invalid', password: SMTP_PASSWORD },
          webhook: { enabled: true, url: WEBHOOK_URL, secret: WEBHOOK_SECRET },
          telegram: { enabled: true, chatId: '-100123', botToken: BOT_TOKEN },
        },
      })
      .expect(200);

    await harness
      .http()
      .delete('/api/v1/settings/notifications/webhook')
      .set({ Cookie: cookie, Origin: harness.origin })
      .expect(200);

    const service = harness.app.get(SettingsService);
    service.invalidate();
    const internal = service.getInternal().notifications;

    expect(internal.email.password).toBe(SMTP_PASSWORD);
    expect(internal.email.host).toBe('smtp.example.invalid');
    expect(internal.telegram.botToken).toBe(BOT_TOKEN);
    expect(internal.telegram.chatId).toBe('-100123');
    expect(internal.webhook.url).toBe('');
  });

  it('clears the email channel including its recipients and password', async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    const cookie = await harness.login();

    await harness
      .http()
      .patch('/api/v1/settings')
      .set({ Cookie: cookie, Origin: harness.origin })
      .send({
        notifications: {
          email: {
            enabled: true,
            host: 'smtp.example.invalid',
            from: 'ops@example.invalid',
            to: ['someone@example.invalid'],
            password: SMTP_PASSWORD,
          },
        },
      })
      .expect(200);

    const response = await harness
      .http()
      .delete('/api/v1/settings/notifications/email')
      .set({ Cookie: cookie, Origin: harness.origin })
      .expect(200);

    expect(response.body.notifications.email.host).toBe('');
    expect(response.body.notifications.email.to).toEqual([]);
    expect(response.body.notifications.email.enabled).toBe(false);
    expect(JSON.stringify(storedNotifications(harness))).not.toContain(SMTP_PASSWORD);
  });

  it('rejects a channel that is not a delivery channel', async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    const cookie = await harness.login();

    // syslog is testable but is an activity sink, not a notification channel.
    const response = await harness
      .http()
      .delete('/api/v1/settings/notifications/syslog')
      .set({ Cookie: cookie, Origin: harness.origin })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION');
  });

  it('needs a session', async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    await harness
      .http()
      .delete('/api/v1/settings/notifications/webhook')
      .set({ Origin: harness.origin })
      .expect(401);
  });

  it('is idempotent: disconnecting a channel that is already clear is a no-op', async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    const cookie = await harness.login();

    await harness
      .http()
      .delete('/api/v1/settings/notifications/telegram')
      .set({ Cookie: cookie, Origin: harness.origin })
      .expect(200);
    const second = await harness
      .http()
      .delete('/api/v1/settings/notifications/telegram')
      .set({ Cookie: cookie, Origin: harness.origin })
      .expect(200);

    expect(second.body.notifications.telegram).toEqual({ enabled: false, chatId: '' });
  });
});
