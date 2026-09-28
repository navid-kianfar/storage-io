import { z } from 'zod';
import { isoDateTime, jsonObject, listOf } from './common.js';

export const ACTIVITY_CATEGORIES = [
  'objects',
  'buckets',
  'access',
  'servers',
  'jobs',
  'system',
  'auth',
] as const;
export const activityCategorySchema = z.enum(ACTIVITY_CATEGORIES);
export type ActivityCategory = z.infer<typeof activityCategorySchema>;

export const ACTIVITY_RESULTS = ['success', 'failure', 'warning'] as const;
export const activityResultSchema = z.enum(ACTIVITY_RESULTS);
export type ActivityResult = z.infer<typeof activityResultSchema>;

export const ACTOR_TYPES = ['admin', 'system', 'token'] as const;
export const actorTypeSchema = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof actorTypeSchema>;

export const activityActorSchema = z.object({ type: actorTypeSchema, name: z.string() });
export type ActivityActor = z.infer<typeof activityActorSchema>;

export const activityEventSchema = z.object({
  id: z.string(),
  at: isoDateTime,
  category: activityCategorySchema,
  /** Dotted verb, e.g. `object.delete`. */
  action: z.string(),
  title: z.string(),
  actor: activityActorSchema,
  target: z.string().nullable(),
  serverId: z.string().nullable(),
  serverName: z.string().nullable(),
  ip: z.string().nullable(),
  result: activityResultSchema,
  requestId: z.string().nullable(),
  details: jsonObject,
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const activityListSchema = listOf(activityEventSchema);
export type ActivityList = z.infer<typeof activityListSchema>;

export const listActivityQuerySchema = z.object({
  q: z.string().max(200).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  serverId: z.string().optional(),
  category: activityCategorySchema.optional(),
  result: activityResultSchema.optional(),
});
export type ListActivityQuery = z.infer<typeof listActivityQuerySchema>;

/** Column order of `/activity/export.csv`, so the web app can label a preview. */
export const ACTIVITY_CSV_COLUMNS = [
  'at',
  'category',
  'action',
  'title',
  'actorType',
  'actorName',
  'target',
  'serverName',
  'ip',
  'result',
  'requestId',
  'details',
] as const;
