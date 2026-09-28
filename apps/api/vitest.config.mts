import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * Three projects, so a failing integration test cannot be mistaken for a broken
 * unit and `pnpm test` stays fast:
 *
 * - `unit` — pure logic, no app, no network. This is what `pnpm test` runs.
 * - `e2e`  — the real Nest app over supertest against an in-memory SQLite.
 * - `it`   — against the MinIO and SeaweedFS containers, skipped unless `S3_IT=1`.
 *
 * `unplugin-swc` compiles the decorators and emits the metadata Nest's DI needs;
 * esbuild alone drops `emitDecoratorMetadata`, which makes every constructor
 * injection fail at runtime with an unhelpful "cannot resolve dependency".
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: false,
    // Nest's DI and the SQLite handle are process-wide; one fork keeps two test
    // files from fighting over the same database file. (Vitest 5 took the
    // options out of `poolOptions` and made them top level.)
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.spec.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'it',
          include: ['test/it/**/*.spec.ts'],
          environment: 'node',
          // Container round trips and argon2id at 64 MiB are not fast.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
