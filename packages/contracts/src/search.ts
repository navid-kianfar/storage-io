import { z } from 'zod';
import { itemsOf } from './common.js';
import { jobStatusSchema } from './jobs.js';

export const SEARCH_RESULT_TYPES = [
  'server',
  'bucket',
  'user',
  'group',
  'key',
  'policy',
  'job',
] as const;
export const searchResultTypeSchema = z.enum(SEARCH_RESULT_TYPES);
export type SearchResultType = z.infer<typeof searchResultTypeSchema>;

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 100;

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).default(SEARCH_LIMIT_DEFAULT),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResultSchema = z.object({
  type: searchResultTypeSchema,
  /**
   * The entity's own opaque id — a server id, a bucket id, or the `iam_entities`
   * id of a user, group, policy or key. Never a name, and never a composite.
   */
  id: z.string(),
  label: z.string(),
  sublabel: z.string(),
  /**
   * A route from docs/ROUTES.md, built from `id` alone. Never a query string and
   * never a name: a name is unique only within one server and is not a safe path
   * segment.
   */
  href: z.string(),
  /**
   * The job's status, so the palette can badge a running job without a second
   * request. `null` for every other type — a server's status is in `sublabel`,
   * because it is a different enum and a palette row shows one badge.
   */
  status: jobStatusSchema.nullable(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = itemsOf(searchResultSchema);
export type SearchResponse = z.infer<typeof searchResponseSchema>;
