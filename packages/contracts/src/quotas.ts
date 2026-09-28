import { z } from 'zod';
import { listOf } from './common.js';
import { bucketSchema } from './buckets.js';

export const QUOTA_FILTERS = ['all', 'near', 'unlimited'] as const;
export const quotaFilterSchema = z.enum(QUOTA_FILTERS);
export type QuotaFilter = z.infer<typeof quotaFilterSchema>;

export const QUOTA_SUPPORT_LEVELS = ['native', 'alert-only', 'unavailable'] as const;
export const quotaSupportSchema = z.enum(QUOTA_SUPPORT_LEVELS);
export type QuotaSupport = z.infer<typeof quotaSupportSchema>;

export const listQuotasQuerySchema = z.object({
  q: z.string().max(200).optional(),
  serverId: z.string().optional(),
  filter: quotaFilterSchema.default('all'),
});
export type ListQuotasQuery = z.infer<typeof listQuotasQuerySchema>;

export const quotaRowSchema = z.object({
  bucket: bucketSchema,
  usageRatio: z.number().min(0).nullable(),
  /** Seven daily sizes, oldest first. */
  trend: z.array(z.number().min(0)),
  supported: quotaSupportSchema,
});
export type QuotaRow = z.infer<typeof quotaRowSchema>;

export const quotaListSchema = listOf(quotaRowSchema).extend({
  summary: z.object({
    withQuota: z.number().int().min(0),
    over90: z.number().int().min(0),
    over80: z.number().int().min(0),
    unlimited: z.number().int().min(0),
  }),
});
export type QuotaList = z.infer<typeof quotaListSchema>;

export const QUOTA_TREND_DAYS = 7;
