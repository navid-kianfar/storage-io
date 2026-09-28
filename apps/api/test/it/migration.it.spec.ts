import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { applyMigrations, createDatabase } from '../../src/db/migrate';
import { servers, settings } from '../../src/db/schema';

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
 * Note for the next agent: there is one migration today, so "upgrading" means
 * re-running the same folder. When you add a migration, add a case here that
 * seeds a database at the previous version and asserts the data survives.
 */

interface SchemaRow {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

const dumpSchema = (client: SqliteDatabase): readonly SchemaRow[] =>
  client
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all() as SchemaRow[];

const appliedMigrations = (client: SqliteDatabase): readonly { hash: string }[] =>
  client.prepare('SELECT hash FROM __drizzle_migrations ORDER BY id').all() as { hash: string }[];

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

      // Applied once, not twice: the journal is what stops a re-run.
      expect(appliedMigrations(second.client)).toHaveLength(1);
    } finally {
      second.client.close();
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
