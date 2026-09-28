#!/usr/bin/env node
/**
 * storage-io — documentation screenshots.
 *
 * Drives the **locally installed Google Chrome** through playwright-core
 * (`channel: 'chrome'`, headless). Nothing is downloaded: playwright-core ships
 * no browsers, and that is the point — this must not pull a 150 MB Chromium
 * into a repository that is otherwise dependency-light.
 *
 *   docker compose -f docker/docker-compose.dev.yml up -d
 *   pnpm dev
 *   pnpm seed:demo          # so the pages have something on them
 *   pnpm screenshots
 *
 * Output: `docs/screenshots/*.png`, 1440x900 at deviceScaleFactor 2 (so 2880x1800
 * files), plus a few at 390x844 for the mobile layout.
 *
 * **Every shot is independent.** A page that fails — a route that moved, a
 * selector that a refactor renamed, a dialog that did not open — is warned about
 * and skipped; the rest still get captured. The run's exit code is 0 unless
 * nothing at all could be captured, because a partial set is still useful.
 *
 * **Ids are resolved at runtime**, through the API, from the signed-in session.
 * `docs/ROUTES.md` is binding: a route param is an opaque id and never a name,
 * so hard-coding one here would be both wrong and brittle.
 *
 * Credentials come from flags, then the environment, then `apps/api/.env` —
 * never from this file, and nothing here prints one.
 *
 * Flags:
 *   --web <url>        SIO_WEB_URL   default http://localhost:5173
 *   --api <url>        SIO_API_URL   default the same origin as --web (it proxies /api)
 *   --username / --password        (same lookup as scripts/seed-demo.mjs)
 *   --out <dir>        default docs/screenshots
 *   --only <a,b,c>     capture only these shots
 *   --headed           watch it run
 */

import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const flags = new Map();
  const bare = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      i += 1;
    } else {
      bare.add(arg.slice(2));
    }
  }
  return { flags, bare };
}

function readDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

const { flags, bare } = parseArgs(process.argv.slice(2));
const dotEnv = readDotEnv(join(REPO_ROOT, 'apps', 'api', '.env'));

const pick = (flag, ...envKeys) => {
  const fromFlag = flags.get(flag);
  if (fromFlag !== undefined && fromFlag !== '') return fromFlag;
  for (const key of envKeys) {
    if (process.env[key]) return process.env[key];
    if (dotEnv[key]) return dotEnv[key];
  }
  return undefined;
};

const WEB = (pick('web', 'SIO_WEB_URL') ?? 'http://localhost:5173').replace(/\/+$/, '');
const CONFIG = {
  web: WEB,
  username: pick('username', 'SIO_ADMIN_USERNAME', 'ADMIN_USERNAME'),
  password: pick('password', 'SIO_ADMIN_PASSWORD', 'ADMIN_PASSWORD'),
  out: resolve(REPO_ROOT, flags.get('out') ?? join('docs', 'screenshots')),
  only:
    flags
      .get('only')
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? null,
  headed: bare.has('headed'),
};

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const SCALE = 2;

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

const results = { captured: [], skipped: [] };
const ok = (name, note) => {
  results.captured.push(name);
  console.log(`  \x1b[32m✓\x1b[0m ${name}.png${note ? `  \x1b[2m${note}\x1b[0m` : ''}`);
};
const skip = (name, why) => {
  results.skipped.push({ name, why });
  console.warn(`  \x1b[33m—\x1b[0m ${name}  \x1b[2m${why}\x1b[0m`);
};

/* ------------------------------------------------------------------ *
 * Page helpers
 * ------------------------------------------------------------------ */

/**
 * `waitUntil: 'networkidle'` is unusable here: the console holds an SSE stream
 * open (`GET /api/v1/events`), so the network is never idle and every goto would
 * time out. This waits for the things that actually matter instead — the
 * document, the web fonts, a rendered landmark, and the loading skeletons going
 * away — and then gives charts a moment to draw.
 */
async function settle(page, { timeout = 15_000 } = {}) {
  await page.waitForLoadState('domcontentloaded');

  await page
    .waitForSelector('main, [role="main"], form', { timeout, state: 'visible' })
    .catch(() => {});

  await page
    .waitForFunction(
      () => document.querySelectorAll('[data-slot="skeleton"], .animate-pulse').length === 0,
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => {});

  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForTimeout(700);
}

async function shoot(page, name, { viewport } = {}) {
  if (viewport !== undefined) await page.setViewportSize(viewport);
  await page.screenshot({ path: join(CONFIG.out, `${name}.png`), scale: 'device' });
}

/** Navigate, settle, capture. The whole thing is one shot's worth of failure. */
async function capture(page, name, path, options = {}) {
  await page.goto(`${CONFIG.web}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await settle(page);
  if (options.before !== undefined) await options.before(page);
  await shoot(page, name, options);
}

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

/**
 * Preferences are a persisted zustand store read before first paint, so they go
 * in before any script runs. `reduceMotion` is the important one: without it the
 * charts and the sheets are mid-animation when the shutter opens.
 */
function prefsScript(language = 'en', theme = 'light') {
  return `try { localStorage.setItem('sio.prefs', ${JSON.stringify(
    JSON.stringify({
      state: { theme, density: 'comfortable', language, reduceMotion: true },
      version: 0,
    }),
  )}); } catch {}`;
}

async function newContext(browser, { viewport = DESKTOP, language = 'en', theme = 'light' } = {}) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: SCALE,
    locale: language === 'fa' ? 'fa-IR' : 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: theme === 'dark' ? 'dark' : 'light',
  });
  await context.addInitScript(prefsScript(language, theme));
  return context;
}

async function signIn(page) {
  await page.goto(`${CONFIG.web}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await settle(page);
  await page.fill('#username', CONFIG.username);
  await page.fill('#password', CONFIG.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }),
    page.click('form button[type="submit"]'),
  ]);
  await settle(page);
}

/**
 * `pnpm dev:mock` runs the app against MSW fixtures, and it looks entirely
 * normal in a screenshot — three invented servers, a bucket called `media-prod`.
 * Documentation shot from it would be a picture of the mocks. MSW installs a
 * service worker, so a controller on this origin is the tell.
 */
async function warnIfMockApi(page) {
  const mocked = await page
    .evaluate(() => navigator.serviceWorker?.controller?.scriptURL ?? null)
    .catch(() => null);
  if (mocked !== null && mocked.includes('mockServiceWorker')) {
    console.warn(
      `  \x1b[33m!\x1b[0m ${CONFIG.web} is running in MOCK mode (MSW) — these shots would be of\n` +
        '    fixtures, not of your installation. Start the app with `pnpm dev` (not\n' +
        '    `dev:mock`) and point --web at it.\n',
    );
    return true;
  }
  return false;
}

/** The API, through the page's own session — no second auth path to keep in step. */
function apiFor(page) {
  return async (path) =>
    page.evaluate(async (p) => {
      const res = await fetch(p, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`${res.status} ${p}`);
      return res.json();
    }, `/api/v1${path}`);
}

/** Every id the route map needs, resolved once. */
async function resolveIds(page) {
  const api = apiFor(page);
  const ids = {};

  const servers = await api('/servers').catch(() => ({ items: [] }));
  const minio = servers.items?.find((s) => s.provider === 'minio') ?? servers.items?.[0];
  ids.serverId = minio?.id ?? null;

  const buckets = await api('/buckets?pageSize=100').catch(() => ({ items: [] }));
  const preferred =
    buckets.items?.find((b) => b.name === 'media-assets') ??
    buckets.items?.find((b) => (b.objects ?? 0) > 0) ??
    buckets.items?.[0];
  ids.bucketId = preferred?.id ?? null;
  ids.bucketName = preferred?.name ?? null;
  ids.bucketServerId = preferred?.serverId ?? null;

  if (ids.bucketId !== null && ids.bucketServerId !== null) {
    const listing = await api(
      `/servers/${ids.bucketServerId}/buckets/${encodeURIComponent(ids.bucketName)}/objects?limit=50`,
    ).catch(() => ({ objects: [] }));
    // An image makes the inspector's preview worth looking at.
    const object =
      listing.objects?.find((o) => /\.(png|jpe?g|svg)$/i.test(o.key)) ?? listing.objects?.[0];
    ids.objectKey = object?.key ?? null;
    ids.prefix = listing.prefixes?.[0]?.prefix ?? '';
  }

  const users = await api('/iam/users?pageSize=50').catch(() => ({ items: [] }));
  ids.userId = users.items?.[0]?.id ?? null;

  const policies = await api('/iam/policies').catch(() => ({ items: [] }));
  const policy = policies.items?.find((p) => p.name.startsWith('sio-demo')) ?? policies.items?.[0];
  ids.policyId = policy?.id ?? null;

  const activity = await api('/activity?pageSize=5').catch(() => ({ items: [] }));
  ids.eventId = activity.items?.[0]?.id ?? null;

  return ids;
}

/* ------------------------------------------------------------------ *
 * The shots
 * ------------------------------------------------------------------ */

function desktopShots(ids) {
  const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

  return [
    { name: 'overview-light', run: (p) => capture(p, 'overview-light', '/?theme=light') },
    { name: 'overview-dark', run: (p) => capture(p, 'overview-dark', '/?theme=dark') },
    { name: 'servers', run: (p) => capture(p, 'servers', '/servers?theme=light') },
    {
      name: 'server-detail',
      needs: 'serverId',
      run: (p) => capture(p, 'server-detail', `/servers/${ids.serverId}`),
    },
    { name: 'buckets', run: (p) => capture(p, 'buckets', '/buckets') },
    {
      name: 'bucket-settings',
      needs: 'bucketId',
      run: (p) => capture(p, 'bucket-settings', `/buckets/${ids.bucketId}`),
    },
    {
      name: 'object-browser',
      needs: 'bucketId',
      run: (p) => capture(p, 'object-browser', `/buckets/${ids.bucketId}/browse/`),
    },
    {
      // The inspector route *is* the object browser with the panel open on a key.
      name: 'object-inspector',
      needs: 'objectKey',
      run: (p) =>
        capture(
          p,
          'object-inspector',
          `/buckets/${ids.bucketId}/object/${encodeKey(ids.objectKey)}`,
        ),
    },
    {
      name: 'upload-dialog',
      needs: 'bucketId',
      run: (p) => capture(p, 'upload-dialog', `/buckets/${ids.bucketId}/upload/`),
    },
    { name: 'quotas', run: (p) => capture(p, 'quotas', '/quotas') },
    { name: 'jobs', run: (p) => capture(p, 'jobs', '/jobs') },
    { name: 'job-wizard', run: (p) => capture(p, 'job-wizard', '/jobs/new') },
    { name: 'transfers', run: (p) => capture(p, 'transfers', '/transfers') },
    { name: 's3-users', run: (p) => capture(p, 's3-users', '/users') },
    {
      name: 's3-user-sheet',
      needs: 'userId',
      run: (p) => capture(p, 's3-user-sheet', `/users/${ids.userId}`),
    },
    { name: 'policies', run: (p) => capture(p, 'policies', '/policies') },
    {
      name: 'policy-editor',
      needs: 'policyId',
      run: (p) => capture(p, 'policy-editor', `/policies/${ids.policyId}`),
    },
    { name: 'access-keys', run: (p) => capture(p, 'access-keys', '/keys') },
    { name: 'access-key-create', run: (p) => capture(p, 'access-key-create', '/keys/new') },
    { name: 'access-key-secret', run: (p) => captureSecretReveal(p) },
    { name: 'activity', run: (p) => capture(p, 'activity', '/activity') },
    {
      name: 'activity-event',
      needs: 'eventId',
      run: (p) => capture(p, 'activity-event', `/activity/${ids.eventId}`),
    },
    { name: 'settings', run: (p) => capture(p, 'settings', '/settings/account') },
    {
      name: 'settings-appearance',
      run: (p) => capture(p, 'settings-appearance', '/settings/appearance'),
    },
    { name: 'command-palette', run: (p) => captureCommandPalette(p) },
  ].filter((shot) => shot.needs === undefined || ids[shot.needs] !== null);
}

async function captureCommandPalette(page) {
  await page.goto(`${CONFIG.web}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await settle(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.waitForSelector('[cmdk-root], [role="dialog"]', { timeout: 5000 });
  await page.waitForTimeout(500);
  await shoot(page, 'command-palette');
}

/**
 * The one-time secret step only exists immediately after a key is created, so
 * this creates one through the dialog exactly as an operator would, captures the
 * reveal, and then deletes that key again through the API — matched on the id it
 * just got back, on the server it just used, so the run leaves nothing behind
 * and can be repeated. Local development MinIO only.
 */
async function captureSecretReveal(page) {
  const before = await apiFor(page)('/iam/access-keys?pageSize=200');
  const known = new Set((before.items ?? []).map((k) => k.id));

  await page.goto(`${CONFIG.web}/keys/new`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await settle(page);

  const chooseFirst = async (label) => {
    const trigger = page.locator(`[role="combobox"][aria-label="${label}"]`).first();
    await trigger.click({ timeout: 5000 });
    await page.locator('[role="option"]').first().click({ timeout: 5000 });
  };

  await chooseFirst('Server');
  await chooseFirst('S3 user');
  await page.getByPlaceholder('GitHub Actions — deploy').fill('screenshot-reveal');
  await page.getByRole('button', { name: 'Create key' }).click();

  await page.waitForTimeout(2500);
  await shoot(page, 'access-key-secret');

  const after = await apiFor(page)('/iam/access-keys?pageSize=200');
  const created = (after.items ?? []).find(
    (k) => !known.has(k.id) && k.name === 'screenshot-reveal',
  );
  if (created !== undefined) {
    await page.evaluate(
      async ({ serverId, accessKeyId }) => {
        await fetch(
          `/api/v1/servers/${serverId}/iam/access-keys/${encodeURIComponent(accessKeyId)}`,
          { method: 'DELETE', headers: { accept: 'application/json' } },
        );
      },
      { serverId: created.serverId, accessKeyId: created.accessKeyId },
    );
  }
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

async function runShots(page, shots) {
  for (const shot of shots) {
    if (CONFIG.only !== null && !CONFIG.only.includes(shot.name)) continue;
    try {
      await shot.run(page);
      ok(shot.name, shot.note);
    } catch (error) {
      skip(shot.name, error instanceof Error ? error.message.split('\n')[0] : String(error));
    }
  }
}

async function main() {
  if (!CONFIG.username || !CONFIG.password) {
    console.error(
      'Admin credentials not found. Set ADMIN_USERNAME / ADMIN_PASSWORD in apps/api/.env,\n' +
        'export SIO_ADMIN_USERNAME / SIO_ADMIN_PASSWORD, or pass --username / --password.',
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(CONFIG.out, { recursive: true });

  let browser;
  try {
    // `channel: 'chrome'` is the installed Google Chrome. playwright-core ships
    // no browsers, so without it there is nothing to launch.
    browser = await chromium.launch({ channel: 'chrome', headless: !CONFIG.headed });
  } catch (error) {
    console.error(
      `Could not launch Google Chrome through playwright-core: ${error.message}\n` +
        'Install Google Chrome (not Chromium) and try again.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nstorage-io screenshots → ${CONFIG.out}`);
  console.log(`  app: ${CONFIG.web}  ·  viewport ${DESKTOP.width}x${DESKTOP.height} @${SCALE}x\n`);

  try {
    // 1. Logged out, for the login page.
    const anon = await newContext(browser);
    const anonPage = await anon.newPage();
    try {
      await anonPage.goto(`${CONFIG.web}/login`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await settle(anonPage);
      await shoot(anonPage, 'login');
      ok('login');
    } catch (error) {
      skip('login', error.message.split('\n')[0]);
    }
    await anon.close();

    // 2. Signed in, desktop.
    const context = await newContext(browser);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);

    try {
      await signIn(page);
    } catch (error) {
      console.error(`\nCould not sign in: ${error.message.split('\n')[0]}`);
      console.error('Is the app running (`pnpm dev`) and are the credentials right?');
      await browser.close();
      process.exitCode = 1;
      return;
    }

    await warnIfMockApi(page);

    const ids = await resolveIds(page);
    const missing = Object.entries(ids)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    if (missing.length > 0) {
      console.warn(
        `  \x1b[33m!\x1b[0m nothing to resolve for: ${missing.join(', ')} — run \`pnpm seed:demo\` first\n`,
      );
    }

    await runShots(page, desktopShots(ids));
    await context.close();

    // 3. RTL, in its own context so the language never leaks into the shots
    //    above (the preference is persisted per browser profile).
    const rtl = await newContext(browser, { language: 'fa' });
    const rtlPage = await rtl.newPage();
    rtlPage.setDefaultTimeout(20_000);
    try {
      await signIn(rtlPage);
      await capture(rtlPage, 'overview-rtl-fa', '/?lang=fa');
      ok('overview-rtl-fa');
      if (ids.bucketId !== null) {
        await capture(rtlPage, 'buckets-rtl-fa', '/buckets?lang=fa');
        ok('buckets-rtl-fa');
      }
    } catch (error) {
      skip('overview-rtl-fa', error.message.split('\n')[0]);
    }
    await rtl.close();

    // 4. Mobile. `docs/ROUTES.md` rule 4 says every page works at 375 px; these
    //    are the shots that prove it.
    const mobile = await newContext(browser, { viewport: MOBILE });
    const mobilePage = await mobile.newPage();
    mobilePage.setDefaultTimeout(20_000);
    try {
      await signIn(mobilePage);
      const paths = [
        { name: 'mobile-overview', path: '/' },
        { name: 'mobile-buckets', path: '/buckets' },
        ids.bucketId !== null
          ? { name: 'mobile-object-browser', path: `/buckets/${ids.bucketId}/browse/` }
          : { name: 'mobile-jobs', path: '/jobs' },
      ];
      await runShots(
        mobilePage,
        paths.map(({ name, path }) => ({
          name,
          note: `${MOBILE.width}x${MOBILE.height}`,
          run: (p) => capture(p, name, path, { viewport: MOBILE }),
        })),
      );
    } catch (error) {
      skip('mobile-*', error.message.split('\n')[0]);
    }
    await mobile.close();
  } finally {
    await browser.close();
  }

  console.log(
    `\n${results.captured.length} captured, ${results.skipped.length} skipped → ${CONFIG.out}`,
  );
  if (results.skipped.length > 0) {
    console.log('Skipped:');
    for (const s of results.skipped) console.log(`  ${s.name}: ${s.why}`);
  }
  if (results.captured.length === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nscreenshots failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
