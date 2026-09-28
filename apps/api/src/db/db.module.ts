import { Global, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { AppConfigService } from '../config/app-config.service';
import { applyMigrations, createDatabase, type AppDatabase } from './migrate';

/** DI token for the Drizzle handle. */
export const DB = Symbol('DB');
/** DI token for the raw better-sqlite3 handle, needed only to close it. */
export const SQLITE_CLIENT = Symbol('SQLITE_CLIENT');

interface OpenedDatabase {
  readonly db: AppDatabase;
  readonly client: SqliteDatabase;
}

/**
 * Owns the SQLite connection's lifetime. Closing it on shutdown is what flushes
 * the WAL; a `close()` someone has to remember to call is exactly the bug
 * `OnApplicationShutdown` exists to prevent.
 */
@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseLifecycle.name);

  constructor(@Inject(SQLITE_CLIENT) private readonly client: SqliteDatabase) {}

  onApplicationShutdown(): void {
    if (!this.client.open) return;
    this.client.close();
    this.logger.log('SQLite connection closed');
  }
}

@Global()
@Module({
  providers: [
    {
      provide: 'OPENED_DATABASE',
      useFactory: (config: AppConfigService): OpenedDatabase => {
        const opened = createDatabase(config.databasePath);
        applyMigrations(opened.db);
        return opened;
      },
      inject: [AppConfigService],
    },
    {
      provide: DB,
      useFactory: (opened: OpenedDatabase): AppDatabase => opened.db,
      inject: ['OPENED_DATABASE'],
    },
    {
      provide: SQLITE_CLIENT,
      useFactory: (opened: OpenedDatabase): SqliteDatabase => opened.client,
      inject: ['OPENED_DATABASE'],
    },
    DatabaseLifecycle,
  ],
  exports: [DB, SQLITE_CLIENT],
})
export class DbModule {}
