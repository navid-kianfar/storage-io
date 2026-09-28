import { defineConfig } from 'drizzle-kit';

/**
 * `pnpm --filter @storage-io/api db:generate` writes a new SQL migration into
 * ./drizzle after the schema changes. The app applies whatever is in that
 * folder at boot (see src/db/migrate.ts), so a generated migration is the only
 * way a schema change reaches an existing database.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: process.env['DATABASE_PATH'] ?? './data/storage-io.sqlite' },
  strict: true,
  verbose: true,
});
