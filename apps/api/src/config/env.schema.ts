import { z } from 'zod';
import { parseCidr } from '../common/net/cidr';

/**
 * Every environment variable the API reads, in one place. Parsing happens once
 * at boot (see `validateEnv`) and a failure stops the process with a list of the
 * offending variables rather than a stack trace three modules later.
 */

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const APP_SECRET_MIN_LENGTH = 32;

/* ------------------------------ trust proxy ----------------------- */

/** The default: believe nothing, so `request.ip` is the socket's peer. */
export const TRUST_PROXY_OFF = 'false';
/** How many reverse proxies a hop count may name. Anything higher is a typo. */
const TRUST_PROXY_MAX_HOPS = 10;
/** Distinguishes "this string is not a valid setting" from the value `false`. */
const INVALID_TRUST_PROXY = Symbol('INVALID_TRUST_PROXY');
/** Express understands these by name; they are passed through, not parsed. */
const NAMED_PROXY_RANGES: readonly string[] = ['loopback', 'linklocal', 'uniquelocal'];

/**
 * What Express's `trust proxy` setting accepts, narrowed to the three forms an
 * operator has a reason to use.
 */
export type TrustProxySetting = false | number | readonly string[];

/**
 * Parses `TRUST_PROXY` into the value Express is given, or the invalid marker.
 *
 * Deliberately **not** accepting `true`: `trust proxy: true` tells Express to
 * believe the left-most `X-Forwarded-For` entry from anybody, which is the exact
 * forgery this variable exists to prevent.
 */
export function parseTrustProxy(raw: string): TrustProxySetting | typeof INVALID_TRUST_PROXY {
  const value = raw.trim();
  if (value.length === 0 || value.toLowerCase() === TRUST_PROXY_OFF) return false;

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > TRUST_PROXY_MAX_HOPS) return INVALID_TRUST_PROXY;
    return hops;
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return INVALID_TRUST_PROXY;

  for (const entry of entries) {
    if (NAMED_PROXY_RANGES.includes(entry)) continue;
    if (parseCidr(entry) === null) return INVALID_TRUST_PROXY;
  }
  return entries;
}

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

    /**
     * Whether `X-Forwarded-For` may be believed, and from whom. Off by default:
     * a trusted hop that is not really there lets any client forge `request.ip`
     * and walk past `Settings.security.allowedNetworks` and the login throttler.
     *
     * `false` (the default), a hop count (`1` — one reverse proxy in front), or a
     * comma-separated list of trusted proxy addresses/CIDRs.
     */
    TRUST_PROXY: z
      .string()
      .default(TRUST_PROXY_OFF)
      .refine((value) => parseTrustProxy(value) !== INVALID_TRUST_PROXY, {
        message:
          'must be "false", a hop count such as "1", or a comma-separated list of proxy addresses or CIDRs',
      }),

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

    /** Turn the background bucket-inventory refresher off — same reasons. */
    INVENTORY_REFRESHER_ENABLED: z.stringbool().default(true),

    /**
     * Turn the IAM background work off — the access-key expiry/rotation sweep and
     * the cached user and key counts. Same reasons: tests and one-shot runs.
     */
    IAM_SCHEDULER_ENABLED: z.stringbool().default(true),

    /**
     * Turn the bulk-job engine and its scheduler off. Same reasons again: the e2e
     * suite drives the engine directly so a run is deterministic, and a one-shot
     * run must not pick up a queued job it will be killed in the middle of.
     */
    JOB_ENGINE_ENABLED: z.stringbool().default(true),

    /**
     * Where the built web app lives. Set, the API serves it with an SPA fallback
     * for every non-`/api` path; unset (the default in development, where Vite
     * serves it) the API is JSON only.
     */
    WEB_DIST: z.string().min(1).optional(),
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
  /** `TRUST_PROXY` in the form Express's `trust proxy` setting takes. */
  readonly trustProxy: TrustProxySetting;
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

  // The schema already refused an unparseable value, so the marker is
  // unreachable here; the guard is what keeps the type honest.
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);

  return {
    ...env,
    isProduction,
    isTest: env.NODE_ENV === 'test',
    logPretty: env.LOG_PRETTY ?? env.NODE_ENV === 'development',
    swaggerEnabled: env.SWAGGER_ENABLED ?? !isProduction,
    allowedOrigins,
    trustProxy: typeof trustProxy === 'symbol' ? false : trustProxy,
  };
}
