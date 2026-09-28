import { z } from 'zod';
import { isoDateTime, itemsOf } from './common.js';

export const SESSION_COOKIE_NAME = 'sio_session';
export const API_TOKEN_PREFIX = 'sio_';

/* ------------------------------ login ----------------------------- */

export const loginRequestSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1024),
  remember: z.boolean().default(false),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const meSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
});
export type Me = z.infer<typeof meSchema>;

export const loginResponseSchema = z.object({ user: meSchema });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const updateMeRequestSchema = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    email: z.email().max(320).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field is required' });
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;

/* ---------------------------- sessions ---------------------------- */

export const authSessionSchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: isoDateTime,
  lastSeenAt: isoDateTime.nullable(),
  expiresAt: isoDateTime,
  current: z.boolean(),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

export const authSessionListSchema = itemsOf(authSessionSchema);
export type AuthSessionList = z.infer<typeof authSessionListSchema>;

export const revokeSessionsQuerySchema = z.object({
  others: z.stringbool().optional(),
});
export type RevokeSessionsQuery = z.infer<typeof revokeSessionsQuerySchema>;

/* ---------------------------- API tokens -------------------------- */

export const apiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: isoDateTime,
  lastUsedAt: isoDateTime.nullable(),
  expiresAt: isoDateTime.nullable(),
});
export type ApiToken = z.infer<typeof apiTokenSchema>;

export const apiTokenListSchema = itemsOf(apiTokenSchema);
export type ApiTokenList = z.infer<typeof apiTokenListSchema>;

export const createApiTokenRequestSchema = z.object({
  name: z.string().min(1).max(120),
  expiresInDays: z.number().int().min(1).max(3650).nullable(),
});
export type CreateApiTokenRequest = z.infer<typeof createApiTokenRequestSchema>;

export const createApiTokenResponseSchema = z.object({
  /** Shown once, never retrievable again. */
  token: z.string(),
  item: apiTokenSchema,
});
export type CreateApiTokenResponse = z.infer<typeof createApiTokenResponseSchema>;

/* ------------------------------ health ---------------------------- */

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSec: z.number().int().min(0),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
