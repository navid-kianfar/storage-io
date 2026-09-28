import { z } from 'zod';
import { itemsOf } from './common.js';

export const SEARCH_RESULT_TYPES = ['server', 'bucket', 'user', 'key', 'policy', 'job'] as const;
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
  id: z.string(),
  label: z.string(),
  sublabel: z.string(),
  href: z.string(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = itemsOf(searchResultSchema);
export type SearchResponse = z.infer<typeof searchResponseSchema>;
