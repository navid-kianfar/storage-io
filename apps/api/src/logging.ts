import { randomUUID } from 'node:crypto';
import type { Params as LoggerParams } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppConfigService } from './config/app-config.service';
import { REQUEST_ID_HEADER } from './common/request-id';

/**
 * Paths that would otherwise fill the log: the SSE stream is one long request
 * and `/health` is polled by whatever supervises the process.
 */
const QUIET_PATHS = ['/api/v1/events', '/health', '/api/v1/health'] as const;

/**
 * Redaction is the point of configuring pino by hand. `autoLogging` prints every
 * request's headers, and `cookie` carries the session token while
 * `authorization` carries an API token — either in a log file is a credential
 * leak that outlives the request.
 */
const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-amz-security-token"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.secretAccessKey',
  'req.body.secret',
  'req.body.passphrase',
  'req.body.adminToken',
  'req.body.botToken',
  'req.body.options.adminToken',
] as const;

export function buildLoggerOptions(config: AppConfigService): LoggerParams {
  const { values } = config;

  return {
    pinoHttp: {
      level: values.LOG_LEVEL,
      redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
      // One id shared by the log line, the response header and the activity row.
      // `requestIdMiddleware` runs first and echoes it on the response, so the
      // fallback here only fires for a request that bypassed it.
      genReqId: (request: IncomingMessage, response): string => {
        const echoed = response.getHeader(REQUEST_ID_HEADER);
        if (typeof echoed === 'string' && echoed.length > 0) return echoed;
        const header = request.headers[REQUEST_ID_HEADER];
        const supplied = Array.isArray(header) ? header[0] : header;
        return supplied ?? randomUUID();
      },
      autoLogging: {
        ignore: (request: IncomingMessage) => {
          const url = request.url ?? '';
          return QUIET_PATHS.some((path) => url.startsWith(path));
        },
      },
      customSuccessMessage: (request: IncomingMessage, response: ServerResponse) =>
        `${request.method ?? '?'} ${request.url ?? '?'} ${response.statusCode}`,
      ...(values.logPretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, singleLine: true, translateTime: 'HH:MM:ss.l' },
            },
          }
        : {}),
    },
  };
}
