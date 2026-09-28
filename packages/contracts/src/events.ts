import { z } from 'zod';
import { activityEventSchema } from './activity.js';
import { isoDateTime, serverStatusSchema } from './common.js';
import { jobStatusSchema, jobProgressSchema } from './jobs.js';
import { notificationSchema } from './notifications.js';

/**
 * SSE stream `GET /api/v1/events`. The `event:` name is the discriminator and
 * `data:` is the JSON payload below, so a client can switch on the name alone.
 */
export const SSE_EVENT_NAMES = [
  'server.health',
  'server.created',
  'server.deleted',
  'job.progress',
  'job.status',
  'notification',
  'inventory.updated',
  'activity.created',
] as const;
export const sseEventNameSchema = z.enum(SSE_EVENT_NAMES);
export type SseEventName = z.infer<typeof sseEventNameSchema>;

export const serverHealthEventPayloadSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  status: serverStatusSchema,
  previousStatus: serverStatusSchema,
  statusDetail: z.string().nullable(),
  latencyMs: z.number().int().min(0).nullable(),
  at: isoDateTime,
});
export type ServerHealthEventPayload = z.infer<typeof serverHealthEventPayloadSchema>;

/**
 * A server was added or removed. Both carry the id and the name rather than the
 * whole `Server`: the stream is a hint about which query to invalidate, and a
 * `deleted` frame has no row left to describe anyway.
 *
 * They exist so a second tab — or a second operator — does not keep a server in
 * its list that no longer exists, or miss one that was just added.
 */
export const serverLifecycleEventPayloadSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  at: isoDateTime,
});
export type ServerLifecycleEventPayload = z.infer<typeof serverLifecycleEventPayloadSchema>;

export const jobProgressEventPayloadSchema = z.object({
  jobId: z.string(),
  progress: jobProgressSchema,
  at: isoDateTime,
});
export type JobProgressEventPayload = z.infer<typeof jobProgressEventPayloadSchema>;

export const jobStatusEventPayloadSchema = z.object({
  jobId: z.string(),
  status: jobStatusSchema,
  previousStatus: jobStatusSchema,
  at: isoDateTime,
});
export type JobStatusEventPayload = z.infer<typeof jobStatusEventPayloadSchema>;

export const notificationEventPayloadSchema = z.object({
  notification: notificationSchema,
  unread: z.number().int().min(0),
});
export type NotificationEventPayload = z.infer<typeof notificationEventPayloadSchema>;

export const inventoryUpdatedEventPayloadSchema = z.object({
  serverId: z.string(),
  buckets: z.number().int().min(0),
  at: isoDateTime,
});
export type InventoryUpdatedEventPayload = z.infer<typeof inventoryUpdatedEventPayloadSchema>;

/**
 * One audit row was recorded. A burst — a bulk action, a job writing a line per
 * page — is throttled into one event carrying the newest row, because the stream
 * exists to tell the web app which query to invalidate, not to deliver the list.
 * `suppressed` is how many further rows were folded into this one, so a client
 * that counts knows it is behind and nothing is dropped silently.
 */
export const activityCreatedEventPayloadSchema = z.object({
  event: activityEventSchema,
  suppressed: z.number().int().min(0),
});
export type ActivityCreatedEventPayload = z.infer<typeof activityCreatedEventPayloadSchema>;

/** One tagged union covering every event on the stream. */
export const sseEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('server.health'), data: serverHealthEventPayloadSchema }),
  z.object({ event: z.literal('server.created'), data: serverLifecycleEventPayloadSchema }),
  z.object({ event: z.literal('server.deleted'), data: serverLifecycleEventPayloadSchema }),
  z.object({ event: z.literal('job.progress'), data: jobProgressEventPayloadSchema }),
  z.object({ event: z.literal('job.status'), data: jobStatusEventPayloadSchema }),
  z.object({ event: z.literal('notification'), data: notificationEventPayloadSchema }),
  z.object({ event: z.literal('inventory.updated'), data: inventoryUpdatedEventPayloadSchema }),
  z.object({ event: z.literal('activity.created'), data: activityCreatedEventPayloadSchema }),
]);
export type SseEvent = z.infer<typeof sseEventSchema>;

/** The payload type for a given event name. */
export type SseEventPayload<TName extends SseEventName> = Extract<
  SseEvent,
  { event: TName }
>['data'];
