import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { IN_MEMORY_PATH } from '../../src/db/migrate';

export const TEST_ADMIN_USERNAME = 'test-admin';
export const TEST_ADMIN_PASSWORD = 'test-password-1234';
export const TEST_APP_SECRET = 'test-app-secret-at-least-32-characters-long';

export interface TestHarness {
  readonly app: NestExpressApplication;
  readonly http: () => request.Agent;
  /**
   * The app's real origin, including the ephemeral port.
   *
   * The Origin guard compares `new URL(origin).host` against the `Host` header,
   * and supertest sends `127.0.0.1:<port>` — so an origin without the port is a
   * cross-origin request as far as the guard is concerned. That is the guard
   * behaving correctly; the harness has to bind a port to have a real origin to
   * send.
   */
  readonly origin: string;
  /** Logs in and returns the `Cookie` header value for an authenticated request. */
  readonly login: (password?: string) => Promise<string>;
  readonly close: () => Promise<void>;
}

/**
 * Boots the real application — the same `createApp` `main.ts` calls, so the
 * global guards, pipe, interceptor and filter are all in place. A harness that
 * assembled its own module graph would test a different app than the one that
 * ships.
 *
 * The database is `:memory:`, which means migrations run through the same
 * `applyMigrations` path a file database uses; the fresh-create path is exercised
 * here and the upgrade path in `test/it/migration.it.spec.ts`.
 */
export async function createTestApp(
  overrides: Readonly<Record<string, string>> = {},
): Promise<TestHarness> {
  const saved = { ...process.env };

  Object.assign(process.env, {
    NODE_ENV: 'test',
    ADMIN_USERNAME: TEST_ADMIN_USERNAME,
    ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    ADMIN_PASSWORD_HASH: undefined,
    APP_SECRET: TEST_APP_SECRET,
    DATABASE_PATH: IN_MEMORY_PATH,
    LOG_LEVEL: 'silent',
    LOG_PRETTY: 'false',
    SWAGGER_ENABLED: 'false',
    // The scheduler would probe unreachable endpoints during every test.
    HEALTH_CHECKER_ENABLED: 'false',
    // Likewise the inventory sweep, which would also make the bucket cache change
    // under a test that just asserted its contents.
    INVENTORY_REFRESHER_ENABLED: 'false',
    // And the IAM sweeps: the expiry pass would disable keys a test just created,
    // and the count cache would fan out to every unreachable endpoint. Tests that
    // want a sweep call `KeyExpiryService.run()` directly, which is deterministic.
    IAM_SCHEDULER_ENABLED: 'false',
    ...overrides,
  });
  // Assigning `undefined` leaves the key present with the string "undefined".
  if (overrides['ADMIN_PASSWORD_HASH'] === undefined) delete process.env['ADMIN_PASSWORD_HASH'];

  const app = await createApp();
  // Bound to an ephemeral port so `origin` is a real one; supertest then reuses
  // this listening server rather than opening its own.
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();

  const http = (): request.Agent => request(app.getHttpServer());

  const login = async (password: string = TEST_ADMIN_PASSWORD): Promise<string> => {
    const response = await http()
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ username: TEST_ADMIN_USERNAME, password, remember: false })
      .expect(201);

    const cookies = response.headers['set-cookie'];
    const list = Array.isArray(cookies) ? cookies : [cookies];
    const session = list.find(
      (cookie) => typeof cookie === 'string' && cookie.startsWith('sio_session='),
    );
    if (session === undefined) throw new Error('Login did not set a session cookie.');
    return session.split(';')[0] as string;
  };

  const close = async (): Promise<void> => {
    await app.close();
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  };

  return { app, http, origin, login, close };
}
