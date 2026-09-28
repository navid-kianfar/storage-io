import { z } from 'zod';

/**
 * Every environment variable the API reads, in one place. Parsing happens once
 * at boot (see `validateEnv`) and a failure stops the process with a list of the
 * offending variables rather than a stack trace three modules later.
 */

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const APP_SECRET_MIN_LENGTH = 32;

/** argon2id PHC string, as `ADMIN_PASSWORD_HASH` must be. */
const ARGON2_PHC =
  /^\$argon2(?:id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+(?:,keyid=[^$,]+)?(?:,data=[^$,]+)?\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('0.0.0.0'),

    /** The single administrator. There is no sign-up and no password change. */
    ADMIN_USERNAME: z.string().min(1).max(200),
    ADMIN_PASSWORD: z.string().min(8).max(1024).optional(),
    ADMIN_PASSWORD_HASH: z
      .string()
      .regex(ARGON2_PHC, 'must be an argon2id PHC string, e.g. $argon2id$v=19$m=65536,t=3,p=4$…')
      .optional(),

    /** HKDF input for the AES-256-GCM key that encrypts server secrets at rest. */
    APP_SECRET: z.string().min(APP_SECRET_MIN_LENGTH),

    DATABASE_PATH: z.string().min(1).default('./data/storage-io.sqlite'),

    COOKIE_SECURE: z.stringbool().default(false),
    /** Extra origins allowed to send cookie-authenticated mutations. */
    ALLOWED_ORIGINS: z.string().default(''),

    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    /** Pretty-print logs. Defaults to on in development, off elsewhere. */
    LOG_PRETTY: z.stringbool().optional(),

    /** Serve Swagger at /api/docs. Defaults to on outside production. */
    SWAGGER_ENABLED: z.stringbool().optional(),

    /** Login throttle: attempts per window, per IP. */
    LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
    LOGIN_RATE_TTL_SEC: z.coerce.number().int().min(1).max(3600).default(60),

    /** Turn the background health checker off — tests and one-shot runs. */
    HEALTH_CHECKER_ENABLED: z.stringbool().default(true),
  })
  .refine((env) => env.ADMIN_PASSWORD !== undefined || env.ADMIN_PASSWORD_HASH !== undefined, {
    message: 'either ADMIN_PASSWORD or ADMIN_PASSWORD_HASH is required',
    path: ['ADMIN_PASSWORD'],
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parsed, immutable view of the environment. Nothing downstream touches
 * `process.env`, so a value can only reach the app through this object.
 */
export interface AppConfig extends Env {
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly logPretty: boolean;
  readonly swaggerEnabled: boolean;
  readonly allowedOrigins: readonly string[];
}

export class EnvValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Invalid environment:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Fails fast, listing every problem rather than only the first. */
export function validateEnv(source: Record<string, unknown>): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const where = issue.path.join('.') || '(root)';
      return `${where}: ${issue.message}`;
    });
    throw new EnvValidationError(problems);
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';
  const allowedOrigins = env.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    ...env,
    isProduction,
    isTest: env.NODE_ENV === 'test',
    logPretty: env.LOG_PRETTY ?? env.NODE_ENV === 'development',
    swaggerEnabled: env.SWAGGER_ENABLED ?? !isProduction,
    allowedOrigins,
  };
}
