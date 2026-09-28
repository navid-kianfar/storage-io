import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { API_PREFIX } from '@storage-io/contracts';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { requestIdMiddleware } from './common/request-id';
import { APP_VERSION } from './version';

const SWAGGER_PATH = 'api/docs';
/** Raw object uploads are streamed, so the JSON limit only has to fit a policy. */
const JSON_BODY_LIMIT = '2mb';

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
    // `/health` is the liveness probe; a version prefix on it only gives
    // whatever supervises the process one more thing to get wrong.
    exclude: ['health'],
  });

  // Before everything: the id has to exist for the logger and the error filter.
  app.use(requestIdMiddleware);

  app.use(
    helmet({
      // The API serves JSON and, in production, the built web app. A strict CSP
      // belongs with whoever serves that app; setting one here would break the
      // Swagger UI without protecting an API that renders no HTML of its own.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
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

  // On-premise installs sit behind one reverse proxy; trusting exactly one hop
  // makes `request.ip` the client rather than the proxy, without letting a
  // client forge it by adding its own X-Forwarded-For entry.
  app.set('trust proxy', 1);

  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });

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

export { SWAGGER_PATH };
