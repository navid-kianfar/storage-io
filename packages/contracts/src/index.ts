/**
 * @storage-io/contracts — zod schemas, inferred types, enums and pure helpers
 * for every endpoint in docs/API.md. Shared by apps/api and apps/web; the doc
 * and the schema change together.
 */

export const API_PREFIX = '/api/v1';
export const API_VERSION = 'v1';

export * from './common.js';
export * from './auth.js';
export * from './servers.js';
export * from './buckets.js';
export * from './objects.js';
export * from './iam.js';
export * from './quotas.js';
export * from './jobs.js';
export * from './activity.js';
export * from './notifications.js';
export * from './dashboard.js';
export * from './search.js';
export * from './settings.js';
export * from './events.js';
export * from './helpers/index.js';
