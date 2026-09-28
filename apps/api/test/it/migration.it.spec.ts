import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { applyMigrations, createDatabase } from '../../src/db/migrate';
import { servers, settings } from '../../src/db/schema';

/** The same folder `applyMigrations` reads, resolved from this file's location. */
const MIGRATIONS_DIRECTORY = resolve(__dirname, '../../drizzle');

/**
 * The migration path against a real file database, not a fixture.
 *
 * A fixture-built schema only exercises the fresh-create path and proves nothing
 * about an upgrade. These tests open a file, migrate it, put data in, and migrate
 * the same file again — which is what happens on every restart and on every
 * deployment of a new version.
 *
 * They also compare a migrated schema against a freshly migrated one, because a
 * schema that differs depending on how the database got there is the bug that
 * only shows up on someone else's machine.
 *
 * Note for the next agent: `upgrades a database left behind by an earlier release`
 * stages a database at the *first* migration only and then applies the whole
 * folder, so it keeps working as migrations are added. If you add one that needs
 * data shaped a particular way to be interesting — a backfill, a column split —
 * seed that shape there too.
 */

interface SchemaRow {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

/**
 * The application schema. `__drizzle_migrations` is excluded: it is the migrator's
 * own bookkeeping, not part of what the app defines, and its DDL text differs
 * depending on which drizzle version created it.
 */
const dumpSchema = (client: SqliteDatabase): readonly SchemaRow[] =>
  client
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
          AND name <> '__drizzle_migrations'
        ORDER BY type, name`,
    )
    .all() as SchemaRow[];

const appliedMigrations = (client: SqliteDatabase): readonly { hash: string }[] =>
  client.prepare('SELECT hash FROM __drizzle_migrations ORDER BY id').all() as { hash: string }[];

/**
 * How many migrations the folder holds. Asserting against this rather than a
 * literal means a new migration does not have to be counted in by hand here — and
 * a migration that the journal failed to record is still caught.
 */
const migrationFileCount = (): number => migrationFiles().length;

const migrationFiles = (): readonly string[] =>
  readdirSync(MIGRATIONS_DIRECTORY)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();

/** drizzle records the SHA-256 of the file's bytes; verified against a live journal. */
const migrationHash = (file: string): string =>
  createHash('sha256')
    .update(readFileSync(join(MIGRATIONS_DIRECTORY, file)))
    .digest('hex');

interface JournalEntry {
  readonly tag: string;
  readonly when: number;
}

/**
 * `meta/_journal.json`, which is what decides whether a migration runs.
 *
 * **Worth knowing:** drizzle's migrator does not compare hashes to find the
 * migrations it still has to apply — it applies every entry whose `when` is newer
 * than the newest `created_at` in `__drizzle_migrations`. A row in that table with
 * a timestamp ahead of a migration's `when` therefore makes that migration be
 * skipped silently, which is why this test stages the journal's own `when` rather
 * than the current clock.
 */
const journalEntries = (): readonly JournalEntry[] => {
  const raw: unknown = JSON.parse(
    readFileSync(join(MIGRATIONS_DIRECTORY, 'meta', '_journal.json'), 'utf8'),
  );
  const { entries } = raw as { entries?: readonly JournalEntry[] };
  return entries ?? [];
};

const journalWhenOf = (file: string): number => {
  const tag = file.replace(/\.sql$/, '');
  const entry = journalEntries().find((candidate) => candidate.tag === tag);
  if (entry === undefined) throw new Error(`No journal entry for ${file}.`);
  return entry.when;
};

/**
 * The journal table drizzle creates, spelled exactly as its better-sqlite3
 * migrator does — taken from a database the migrator itself created.
 */
const DRIZZLE_JOURNAL_DDL = `CREATE TABLE IF NOT EXISTS \`__drizzle_migrations\` (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
)`;

describe('migrations against a real file database', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sio-migrate-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates every table on a fresh file', () => {
    const { db, client } = createDatabase(join(directory, 'fresh.sqlite'));
    try {
      applyMigrations(db);

      const tables = dumpSchema(client)
        .filter((row) => row.type === 'table')
        .map((row) => row.name);

      for (const expected of [
        'activity',
        'api_tokens',
        'bucket_cache',
        'health_events',
        'job_logs',
        'jobs',
        'key_meta',
        'metrics_capacity',
        'metrics_latency',
        'notifications',
        'policy_versions',
        'quotas',
        'server_checks',
        'servers',
        'sessions',
        'settings',
      ]) {
        expect(tables, expected).toContain(expected);
      }
    } finally {
      client.close();
    }
  });

  it('re-running the migrations on an existing database keeps the data', () => {
    let appliedAfterFirstRun = 0;
    const path = join(directory, 'existing.sqlite');
    const now = new Date().toISOString();

    const first = createDatabase(path);
    try {
      applyMigrations(first.db);
      first.db
        .insert(servers)
        .values({
          id: 'server-1',
          name: 'kept-server',
          provider: 'minio',
          endpoint: 'http://127.0.0.1:9000',
          region: 'us-east-1',
          accessKeyId: 'AKIA',
          secretEncrypted: 'v1.aaa.bbb.ccc',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      first.db
        .insert(settings)
        .values({ section: 'health', value: { latencyWarnMs: 777 }, updatedAt: now })
        .run();
      appliedAfterFirstRun = appliedMigrations(first.client).length;
    } finally {
      first.client.close();
    }

    // A second process opening the same file — a restart, or a new release.
    const second = createDatabase(path);
    try {
      applyMigrations(second.db);

      const rows = second.db.select().from(servers).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('kept-server');

      const stored = second.db.select().from(settings).all();
      expect(stored[0]?.value).toEqual({ latencyWarnMs: 777 });

      // Applied once each, not twice: the journal is what stops a re-run. The
      // expected count is what the first run recorded rather than a literal, so
      // adding a migration does not make this test wrong.
      expect(appliedMigrations(second.client)).toHaveLength(appliedAfterFirstRun);
      expect(appliedAfterFirstRun).toBe(migrationFileCount());
    } finally {
      second.client.close();
    }
  });

  /**
   * The upgrade path, which is the one a fixture cannot exercise: a database as an
   * earlier release left it, then the current folder applied on top.
   *
   * It is staged by running the first migration's SQL directly and writing the
   * journal row drizzle would have written, because that is what an older release
   * actually left on disk — not a schema built from the current `schema.ts`.
   */
  it('upgrades a database left behind by an earlier release', () => {
    const files = migrationFiles();
    const [first] = files;
    if (first === undefined) throw new Error('There are no migrations to test.');

    const path = join(directory, 'staged.sqlite');
    const now = new Date().toISOString();

    const earlier = createDatabase(path);
    try {
      earlier.client.exec(DRIZZLE_JOURNAL_DDL);
      for (const statement of readFileSync(join(MIGRATIONS_DIRECTORY, first), 'utf8').split(
        '--> statement-breakpoint',
      )) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) earlier.client.exec(trimmed);
      }
      earlier.client
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        // The journal's own timestamp, not the clock: see `journalEntries`.
        .run(migrationHash(first), journalWhenOf(first));

      // Data an operator already had before the upgrade.
      earlier.db
        .insert(servers)
        .values({
          id: 'server-upgrade',
          name: 'pre-upgrade',
          provider: 'minio',
          endpoint: 'http://127.0.0.1:9000',
          region: 'us-east-1',
          accessKeyId: 'AKIA',
          secretEncrypted: 'v1.aaa.bbb.ccc',
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } finally {
      earlier.client.close();
    }

    const upgraded = createDatabase(path);
    let upgradedSchema: readonly SchemaRow[];
    try {
      applyMigrations(upgraded.db);

      // Every migration is now recorded, and the earlier one was not re-applied.
      expect(appliedMigrations(upgraded.client).map((row) => row.hash)).toEqual(
        files.map(migrationHash),
      );

      const rows = upgraded.db.select().from(servers).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('pre-upgrade');

      upgradedSchema = dumpSchema(upgraded.client);
    } finally {
      upgraded.client.close();
    }

    // And the upgraded schema is the same one a fresh install gets.
    const freshPath = join(directory, 'fresh-for-upgrade.sqlite');
    const fresh = createDatabase(freshPath);
    try {
      applyMigrations(fresh.db);
      expect(upgradedSchema).toEqual(dumpSchema(fresh.client));
    } finally {
      fresh.client.close();
    }
  });

  it('a migrated database and a fresh one have an identical schema', () => {
    const migratedPath = join(directory, 'migrated.sqlite');
    const freshPath = join(directory, 'fresh-again.sqlite');

    // Migrate, use, then migrate again — the "upgraded" database.
    const staged = createDatabase(migratedPath);
    try {
      applyMigrations(staged.db);
    } finally {
      staged.client.close();
    }
    const reopened = createDatabase(migratedPath);
    let migratedSchema: readonly SchemaRow[];
    try {
      applyMigrations(reopened.db);
      migratedSchema = dumpSchema(reopened.client);
    } finally {
      reopened.client.close();
    }

    const fresh = createDatabase(freshPath);
    let freshSchema: readonly SchemaRow[];
    try {
      applyMigrations(fresh.db);
      freshSchema = dumpSchema(fresh.client);
    } finally {
      fresh.client.close();
    }

    expect(migratedSchema).toEqual(freshSchema);
  });

  it('enables foreign keys, so a cascade actually cascades', () => {
    const { db, client } = createDatabase(join(directory, 'fk.sqlite'));
    try {
      applyMigrations(db);
      const [row] = client.prepare('PRAGMA foreign_keys').all() as { foreign_keys: number }[];
      expect(row?.foreign_keys).toBe(1);

      const now = new Date().toISOString();
      db.insert(servers)
        .values({
          id: 'server-fk',
          name: 'fk-server',
          provider: 'minio',
          endpoint: 'http://127.0.0.1:9000',
          region: 'us-east-1',
          accessKeyId: 'AKIA',
          secretEncrypted: 'v1.a.b.c',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      client
        .prepare('INSERT INTO metrics_latency (server_id, at, ms, reachable) VALUES (?, ?, ?, ?)')
        .run('server-fk', now, 12, 1);

      expect(client.prepare('SELECT count(*) AS n FROM metrics_latency').get()).toEqual({ n: 1 });

      client.prepare('DELETE FROM servers WHERE id = ?').run('server-fk');
      // Without the pragma the metric row would survive its server.
      expect(client.prepare('SELECT count(*) AS n FROM metrics_latency').get()).toEqual({ n: 0 });
    } finally {
      client.close();
    }
  });

  it('creates the directory of a database path that does not exist yet', () => {
    const nested = join(directory, 'a', 'b', 'c', 'storage-io.sqlite');
    const { db, client } = createDatabase(nested);
    try {
      applyMigrations(db);
      expect(dumpSchema(client).length).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  it('uses WAL, so the health checker can write while a request reads', () => {
    const { db, client } = createDatabase(join(directory, 'wal.sqlite'));
    try {
      applyMigrations(db);
      const [row] = client.prepare('PRAGMA journal_mode').all() as { journal_mode: string }[];
      expect(row?.journal_mode).toBe('wal');
    } finally {
      client.close();
    }
  });
});
