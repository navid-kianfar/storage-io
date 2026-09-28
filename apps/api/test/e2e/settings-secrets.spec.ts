import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DB } from '../../src/db/db.module';
import type { AppDatabase } from '../../src/db/migrate';
import { settings as settingsTable } from '../../src/db/schema';
import { SettingsService } from '../../src/settings/settings.service';
import { createTestApp, type TestHarness } from '../support/test-app';

/**
 * A settings row is as readable as any other table to anyone holding the SQLite
 * file, so the three notification secrets must not be in it in the clear. These
 * cases look at the stored row itself — the one place where "it works" and "it is
 * safe" can disagree without anything on the wire changing.
 */

const SMTP_PASSWORD = 'smtp-p4ssw0rd-not-in-the-file';
const WEBHOOK_SECRET = 'webhook-s3cret-not-in-the-file';
const BOT_TOKEN = '123456:bot-token-not-in-the-file';

describe('notification secrets at rest (e2e)', () => {
  let harness: TestHarness | null = null;

  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  /** The `notifications` row exactly as it sits in the database. */
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

  it('writes no plaintext secret to the database, and round-trips it', async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    const cookie = await harness.login();

    const response = await harness
      .http()
      .patch('/api/v1/settings')
      .set({ Cookie: cookie, Origin: harness.origin })
      .send({
        notifications: {
          email: { password: SMTP_PASSWORD },
          webhook: { secret: WEBHOOK_SECRET },
          telegram: { botToken: BOT_TOKEN },
        },
      })
      .expect(200);

    // Still write-only on the wire.
    expect(response.body.notifications.email.password).toBeUndefined();
    expect(response.body.notifications.webhook.secret).toBeUndefined();
    expect(response.body.notifications.telegram.botToken).toBeUndefined();

    const raw = JSON.stringify(storedNotifications(harness));
    expect(raw).not.toContain(SMTP_PASSWORD);
    expect(raw).not.toContain(WEBHOOK_SECRET);
    expect(raw).not.toContain(BOT_TOKEN);
    // What is there is the crypto service's own envelope.
    expect(raw).toMatch(/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);

    // And the channel drivers still get the real values.
    const internal = harness.app.get(SettingsService).getInternal().notifications;
    expect(internal.email.password).toBe(SMTP_PASSWORD);
    expect(internal.webhook.secret).toBe(WEBHOOK_SECRET);
    expect(internal.telegram.botToken).toBe(BOT_TOKEN);
  });

  it('reads back after the cache is dropped, which is what a restart looks like', async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    const cookie = await harness.login();

    await harness
      .http()
      .patch('/api/v1/settings')
      .set({ Cookie: cookie, Origin: harness.origin })
      .send({ notifications: { webhook: { secret: WEBHOOK_SECRET } } })
      .expect(200);

    const service = harness.app.get(SettingsService);
    service.invalidate();
    expect(service.getInternal().notifications.webhook.secret).toBe(WEBHOOK_SECRET);
  });

  it('leaves a cleared secret cleared rather than encrypting an empty string', async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    const cookie = await harness.login();

    await harness
      .http()
      .patch('/api/v1/settings')
      .set({ Cookie: cookie, Origin: harness.origin })
      .send({ notifications: { webhook: { secret: WEBHOOK_SECRET } } })
      .expect(200);
    await harness
      .http()
      .patch('/api/v1/settings')
      .set({ Cookie: cookie, Origin: harness.origin })
      .send({ notifications: { webhook: { secret: '' } } })
      .expect(200);

    const service = harness.app.get(SettingsService);
    service.invalidate();
    expect(service.getInternal().notifications.webhook.secret).toBe('');
  });

  it('migrates a row that was written in the clear, and does so only once', async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    const cookie = await harness.login();
    const service = harness.app.get(SettingsService);
    const db = harness.app.get<AppDatabase>(DB);

    // Write the section normally, then put the secrets back as plaintext — which
    // is exactly the row an installation upgrading to this version has.
    await harness
      .http()
      .patch('/api/v1/settings')
      .set({ Cookie: cookie, Origin: harness.origin })
      .send({ notifications: { webhook: { url: 'https://example.invalid/hook' } } })
      .expect(200);

    const legacy = structuredClone(storedNotifications(harness)) as Record<
      string,
      Record<string, unknown>
    >;
    (legacy['email'] as Record<string, unknown>)['password'] = SMTP_PASSWORD;
    (legacy['webhook'] as Record<string, unknown>)['secret'] = WEBHOOK_SECRET;
    (legacy['telegram'] as Record<string, unknown>)['botToken'] = BOT_TOKEN;
    db.update(settingsTable)
      .set({ value: legacy })
      .where(eq(settingsTable.section, 'notifications'))
      .run();
    service.invalidate();

    // The bootstrap hook is what a restart runs.
    service.onApplicationBootstrap();

    const migrated = JSON.stringify(storedNotifications(harness));
    expect(migrated).not.toContain(SMTP_PASSWORD);
    expect(migrated).not.toContain(WEBHOOK_SECRET);
    expect(migrated).not.toContain(BOT_TOKEN);
    expect(service.getInternal().notifications.email.password).toBe(SMTP_PASSWORD);

    // Idempotent: running it again must not encrypt the ciphertext a second time.
    const afterFirst = JSON.stringify(storedNotifications(harness));
    service.onApplicationBootstrap();
    expect(JSON.stringify(storedNotifications(harness))).toBe(afterFirst);
    service.invalidate();
    expect(service.getInternal().notifications.webhook.secret).toBe(WEBHOOK_SECRET);
  });
});
