import { Logger, Module, type DynamicModule } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServeStaticModule } from '@nestjs/serve-static';

/**
 * Serves the built web app in production, from `WEB_DIST`.
 *
 * In development Vite serves it on :5173 and proxies `/api` here, so `WEB_DIST` is
 * unset and this module registers nothing — which is why it is a `DynamicModule`
 * rather than a module with a runtime conditional inside it.
 *
 * ## Why it is last in `AppModule`
 *
 * The SPA fallback answers **every** GET no controller claimed: that is what makes
 * `/buckets/photos` a deep link into a client-side router rather than a 404. So
 * anything registered after it would never be reached, and the two things that must
 * not be swallowed are excluded by hand:
 *
 * - `/api/…` — a request to a route that does not exist must come back as a 404 in
 *   problem+json, not as an HTML page a `fetch` cannot parse.
 * - `/health` — it sits outside the version prefix (see `bootstrap.ts`), so the
 *   `/api` pattern does not cover it, and a probe handed HTML would report a healthy
 *   process forever.
 *
 * The patterns are path-to-regexp v8 syntax, which is what `@nestjs/serve-static`
 * v5 and Express 5 use: `{/*path}` is an optional trailing wildcard, so `/api` and
 * `/api/v1/jobs` are both excluded by one entry.
 *
 * ## Caching
 *
 * Vite fingerprints everything it emits, so `assets/index-a1b2c3d4.js` is immutable
 * for a year and a browser never revalidates it. `index.html` is the opposite: it is
 * the document that *names* those fingerprints, so a cached copy after a deploy
 * points at files that no longer exist. It is served `no-cache`, which still allows a
 * conditional request — the ETag does the work, and an unchanged deploy answers 304
 * rather than resending the document.
 *
 * ## Why `process.env` is read directly
 *
 * `forRoot()` runs while `AppModule`'s decorator metadata is built, before any
 * provider exists, so `AppConfigService` cannot be injected into this decision.
 * `WEB_DIST` is a path with no coercion or defaulting, and the schema validates it
 * as `z.string().min(1).optional()` — so reading it raw here cannot disagree with
 * the validated view. It is the only variable read this way, and
 * `AppConfigService.webDist` is what everything else uses.
 */

const INDEX_FILE = 'index.html';

/** Everything under the API's first path segment, plus the unprefixed probe. */
const EXCLUDED_PATTERNS: readonly string[] = ['/api{/*path}', '/health{/*path}'];

@Module({})
export class WebStaticModule {
  static forRoot(): DynamicModule {
    const logger = new Logger(WebStaticModule.name);
    const webDist = webDistPath(logger);

    if (webDist === null) return { module: WebStaticModule, imports: [] };

    logger.log(`Serving the web app from ${webDist}`);
    return {
      module: WebStaticModule,
      imports: [
        ServeStaticModule.forRoot({
          rootPath: webDist,
          exclude: [...EXCLUDED_PATTERNS],
          serveStaticOptions: {
            etag: true,
            lastModified: true,
            index: [INDEX_FILE],
            setHeaders: (response: StaticResponse, path: string): void => {
              response.setHeader('Cache-Control', cacheControlFor(path));
            },
          },
        }),
      ],
    };
  }
}

/* ------------------------------ helpers --------------------------- */

/** Only the method this module uses, so Express's types stay out of the signature. */
interface StaticResponse {
  setHeader(name: string, value: string): void;
}

/**
 * `null` when the API is JSON only. The path is resolved to an absolute one once,
 * here, so a relative `WEB_DIST` does not depend on the working directory at the
 * moment a request arrives.
 */
function webDistPath(logger: Logger): string | null {
  const configured = process.env['WEB_DIST'];
  if (configured === undefined || configured.length === 0) return null;

  const absolute = resolve(configured);
  if (!existsSync(resolve(absolute, INDEX_FILE))) {
    // A misconfigured path has to be loud: serving nothing out of a directory with
    // no index.html shows an operator a blank page with no explanation.
    logger.error(
      `WEB_DIST is ${absolute} but there is no ${INDEX_FILE} there; the web app is not being served.`,
    );
    return null;
  }
  return absolute;
}

/**
 * Hashed assets are immutable; the document that names them must never be.
 * Exported for the unit test — this rule is the difference between a deploy an
 * operator sees and one they have to hard-refresh for.
 */
export function cacheControlFor(filePath: string): string {
  if (filePath.endsWith(INDEX_FILE)) return 'no-cache';
  return isFingerprinted(filePath) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
}

/** `index-a1b2c3d4.js` — Vite's content hash before the extension. */
const FINGERPRINT = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

export const isFingerprinted = (filePath: string): boolean => FINGERPRINT.test(filePath);
