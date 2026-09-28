import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import SqliteConstructor, { type Database as SqliteDatabase } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

/** The typed Drizzle handle every repository injects. */
export type AppDatabase = BetterSQLite3Database<typeof schema>;

const MIGRATIONS_FOLDER = resolve(__dirname, '../../drizzle');

/**
 * `:memory:` is how the e2e suite gets a fresh database per test file. Any other
 * value is a file whose directory is created when missing, so a first run on a
 * clean checkout does not fail on an absent ./data.
 */
export const IN_MEMORY_PATH = ':memory:';

export function openSqlite(databasePath: string): SqliteDatabase {
  if (databasePath !== IN_MEMORY_PATH) {
    const directory = dirname(resolve(databasePath));
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  }

  const sqlite = new SqliteConstructor(databasePath);
  // WAL survives a crash better and lets the health checker write while a
  // request reads. A no-op on :memory:.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  // Off by default in SQLite; the schema declares references, so honour them.
  sqlite.pragma('foreign_keys = ON');
  return sqlite;
}

/**
 * Applies the generated migrations. This is the ONLY path that creates or
 * changes the schema: a fresh file and an existing one run the same SQL, so an
 * upgraded database cannot end up a different shape from a fresh install.
 */
export function applyMigrations(db: AppDatabase, logger = new Logger('Migrations')): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  logger.log(`Applied migrations from ${MIGRATIONS_FOLDER}`);
}

export function createDatabase(databasePath: string): {
  db: AppDatabase;
  client: SqliteDatabase;
} {
  const client = openSqlite(databasePath);
  const db = drizzle(client, { schema });
  return { db, client };
}
