import { z } from 'zod';
import { isoDateTime, serverStatusSchema } from './common.js';
import { jobStatusSchema, jobProgressSchema } from './jobs.js';
import { notificationSchema } from './notifications.js';

/**
 * SSE stream `GET /api/v1/events`. The `event:` name is the discriminator and
 * `data:` is the JSON payload below, so a client can switch on the name alone.
 */
export const SSE_EVENT_NAMES = [
  'server.health',
  'job.progress',
  'job.status',
  'notification',
  'inventory.updated',
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

/** One tagged union covering every event on the stream. */
export const sseEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('server.health'), data: serverHealthEventPayloadSchema }),
  z.object({ event: z.literal('job.progress'), data: jobProgressEventPayloadSchema }),
  z.object({ event: z.literal('job.status'), data: jobStatusEventPayloadSchema }),
  z.object({ event: z.literal('notification'), data: notificationEventPayloadSchema }),
  z.object({ event: z.literal('inventory.updated'), data: inventoryUpdatedEventPayloadSchema }),
]);
export type SseEvent = z.infer<typeof sseEventSchema>;

/** The payload type for a given event name. */
export type SseEventPayload<TName extends SseEventName> = Extract<
  SseEvent,
  { event: TName }
>['data'];
