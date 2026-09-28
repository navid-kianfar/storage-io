import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { Logger as PinoLogger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { API_PREFIX } from '@storage-io/contracts';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import type { TrustProxySetting } from './config/env.schema';
import { requestIdMiddleware } from './common/request-id';
import { HEALTH_PATHS } from './health/health.controller';
import { isRawObjectBodyRequest } from './modules/objects/raw-upload';
import { APP_VERSION } from './version';

const SWAGGER_PATH = 'api/docs';
/** Raw object uploads are streamed, so the JSON limit only has to fit a policy. */
const JSON_BODY_LIMIT = '2mb';

/**
 * The policy the single-page app runs under, and the reason each relaxation is
 * there. Everything not named falls to `default-src 'self'`; the app talks to
 * nothing but its own origin.
 *
 * - `style-src 'unsafe-inline'` — Radix (under shadcn/ui) writes `style=`
 *   attributes for popover and dropdown positioning. Removing it is a component
 *   library change, not a header change.
 * - `img-src`/`media-src` take `blob:` because previews and downloads are
 *   assembled client-side from object URLs, and `data:` for inline icons.
 * - `frame-src 'self' blob:` is the PDF preview's iframe.
 * - `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'` close the
 *   plugin, base-tag and clickjacking paths, none of which the app uses.
 */
export const SPA_CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'media-src': ["'self'", 'blob:'],
  'connect-src': ["'self'"],
  'frame-src': ["'self'", 'blob:'],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

/**
 * Builds the application without listening, so the e2e suite gets exactly the
 * app `main.ts` runs — the same guards, pipes, filters and middleware. A test
 * harness that assembles its own app proves nothing about production.
 */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  app.useLogger(app.get(PinoLogger));
  const config = app.get(AppConfigService);

  app.setGlobalPrefix(API_PREFIX, {
    // `HealthController` declares both `health` and `api/v1/health` itself — see
    // HEALTH_PATHS — so both have to be excluded here or the prefix would be
    // applied on top and the second would become `/api/v1/api/v1/health`.
    exclude: [...HEALTH_PATHS],
  });

  // Before everything: the id has to exist for the logger and the error filter.
  app.use(requestIdMiddleware);

  // The SPA is same-origin with the API, so a policy set here is the policy the
  // app runs under. Swagger UI is the one document that cannot live with it (its
  // bundle inlines its own bootstrap script), so it gets the same helmet minus
  // the CSP. Object downloads overwrite the header with their own, far stricter
  // policy — see `applyDownloadHeaders`.
  const withCsp = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        ...SPA_CSP_DIRECTIVES,
        'script-src': ["'self'", ...inlineScriptHashes(config.webDist)],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  const withoutCsp = helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const handler = isSwaggerRequest(request) ? withoutCsp : withCsp;
    handler(request, response, next);
  });
  app.use(
    compression({
      filter: (request, response) => {
        // Compressing an SSE stream breaks it: the response is buffered until the
        // window fills, so events arrive in bursts or not at all. `originalUrl`,
        // not `path`: this runs as middleware, where Express may have rewritten
        // `path` to the mount-relative form.
        if (request.originalUrl.split('?')[0]?.endsWith('/events') === true) return false;
        return compression.filter(request, response);
      },
    }),
  );
  app.use(cookieParser());

  // Off unless `TRUST_PROXY` names the proxies in front of this API. Trusting a
  // hop that is not there is not a small mistake: `X-Forwarded-For` is a request
  // header any client can write, and `request.ip` is what the allowed-networks
  // middleware, the login throttler and every activity row are keyed on.
  app.set('trust proxy', trustProxyValue(config.trustProxy));

  // Both parsers match on Content-Type, and the object upload routes carry the
  // object itself as the body — so an upload declaring `application/json` or
  // `application/x-www-form-urlencoded` would be read into memory, parsed, and
  // reach the handler as an empty stream. `type` excludes those two routes
  // whatever type they declare. See modules/objects/raw-upload.ts.
  app.useBodyParser('json', {
    limit: JSON_BODY_LIMIT,
    type: (request) => !isRawObjectBodyRequest(request) && isJsonContentType(request),
  });
  app.useBodyParser('urlencoded', {
    extended: true,
    limit: JSON_BODY_LIMIT,
    type: (request) => !isRawObjectBodyRequest(request) && isUrlEncodedContentType(request),
  });

  // Flushes the SQLite WAL, closes provider clients and completes the event bus.
  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    setUpSwagger(app);
  }

  return app;
}

function setUpSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('storage-io API')
      .setDescription('See docs/API.md. Schemas come from @storage-io/contracts.')
      .setVersion(APP_VERSION)
      .addCookieAuth('sio_session')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'sio_…' })
      .build(),
  );

  // nestjs-zod leaves internal `$ref`s behind that Swagger UI cannot resolve.
  SwaggerModule.setup(SWAGGER_PATH, app, cleanupOpenApiDoc(document));
  new Logger('Swagger').log(`API documentation at /${SWAGGER_PATH}`);
}

/**
 * What each parser's default `type` matches, restated because supplying a `type`
 * function replaces that default rather than adding to it.
 */
function mimeOf(request: { headers: Record<string, unknown> }): string | null {
  const header = request.headers['content-type'];
  if (typeof header !== 'string') return null;
  return (header.split(';')[0] ?? '').trim().toLowerCase();
}

function isJsonContentType(request: { headers: Record<string, unknown> }): boolean {
  const mime = mimeOf(request);
  if (mime === null) return false;
  return mime === 'application/json' || mime.endsWith('+json');
}

function isUrlEncodedContentType(request: { headers: Record<string, unknown> }): boolean {
  return mimeOf(request) === 'application/x-www-form-urlencoded';
}

/**
 * `'sha256-…'` for each inline `<script>` in the built `index.html`.
 *
 * The app has exactly one and it has to stay inline: it reads the stored theme,
 * language and direction and writes them onto `<html>` **before first paint**, so
 * moving it into the bundle would show every operator a flash of the wrong theme
 * and, in Persian or Arabic, a flash of the wrong text direction. `'unsafe-inline'`
 * would allow it — and would allow every other inline script with it, which is
 * most of what a CSP is for.
 *
 * The hashes are computed from the file being served rather than written down
 * here, so editing `index.html` cannot silently break the app: a deploy replaces
 * the directory and restarts, and the restart reads the new file.
 *
 * An unreadable or absent index yields none, and the policy is simply
 * `script-src 'self'` — correct for a JSON-only API, which is what `WEB_DIST`
 * unset means.
 */
function inlineScriptHashes(webDist: string | null): readonly string[] {
  if (webDist === null) return [];

  let html: string;
  try {
    html = readFileSync(resolve(webDist, 'index.html'), 'utf8');
  } catch {
    return [];
  }

  // `(?![^>]*\ssrc=)` skips the bundle's own <script src=…>, which `'self'`
  // already covers and which has no body to hash.
  const inlineScript = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const hashes: string[] = [];
  for (const match of html.matchAll(inlineScript)) {
    const body = match[1] ?? '';
    if (body.trim().length === 0) continue;
    const digest = createHash('sha256').update(body, 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

/**
 * Express wants a mutable array for the list form, and rejects a `readonly` one
 * at the type level only — so the copy is here rather than at the call site.
 */
function trustProxyValue(setting: TrustProxySetting): false | number | string[] {
  if (setting === false) return false;
  if (typeof setting === 'number') return setting;
  return [...setting];
}

/**
 * `originalUrl`, not `path`: this runs as middleware, where Express may have
 * rewritten `path` to the mount-relative form.
 */
function isSwaggerRequest(request: Request): boolean {
  const path = request.originalUrl.split('?')[0] ?? '';
  return path === `/${SWAGGER_PATH}` || path.startsWith(`/${SWAGGER_PATH}/`);
}

export { SWAGGER_PATH };
