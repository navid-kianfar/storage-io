import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  applyMigrations,
  createDatabase,
  IN_MEMORY_PATH,
  type AppDatabase,
} from '../../src/db/migrate';
import { servers } from '../../src/db/schema';
import { KeyMetaRepository } from '../../src/modules/iam-core/key-meta.repository';

/**
 * `key_meta`'s queries, against a real migrated SQLite rather than a mocked one.
 *
 * The scheduler's correctness is entirely in this SQL: which keys are due to be
 * disabled, which rotations are finished, and which expiries have already been
 * announced. A mock would have agreed with whatever the code did, including the
 * wrong comparison — these run the statements.
 */

const SERVER_ID = 'server-1';

describe('KeyMetaRepository', () => {
  let db: AppDatabase;
  let close: () => void;
  let repository: KeyMetaRepository;

  beforeEach(() => {
    const created = createDatabase(IN_MEMORY_PATH);
    db = created.db;
    close = () => created.client.close();
    // The same migration path a fresh install and an upgrade both take.
    applyMigrations(db, silentLogger());

    // `key_meta.server_id` has a foreign key, so a server row has to exist.
    db.insert(servers)
      .values({
        id: SERVER_ID,
        name: 'minio-lab',
        provider: 'minio',
        endpoint: 'http://127.0.0.1:9000',
        region: 'us-east-1',
        accessKeyId: 'key',
        secretEncrypted: 'encrypted',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    repository = new KeyMetaRepository(db);
  });

  afterEach(() => {
    close();
  });

  it('inserts a row and reads it back', () => {
    repository.upsert(SERVER_ID, 'AK1', { userName: 'alice', name: 'first', status: 'active' });

    const row = repository.find(SERVER_ID, 'AK1');
    expect(row?.userName).toBe('alice');
    expect(row?.name).toBe('first');
    expect(row?.expiresAt).toBeNull();
  });

  it('merges a patch instead of replacing the row', () => {
    repository.upsert(SERVER_ID, 'AK1', {
      userName: 'alice',
      name: 'first',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    repository.upsert(SERVER_ID, 'AK1', { lastUsedAt: '2026-06-01T00:00:00.000Z' });

    const row = repository.find(SERVER_ID, 'AK1');
    // The expiry an operator set must survive a key being observed during a list.
    expect(row?.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect(row?.name).toBe('first');
    expect(row?.lastUsedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('can clear a field by patching it to null', () => {
    repository.upsert(SERVER_ID, 'AK1', {
      userName: 'alice',
      rotationReplacedBy: 'AK2',
      rotationDisableAt: '2026-06-01T00:00:00.000Z',
    });
    repository.upsert(SERVER_ID, 'AK1', { rotationReplacedBy: null, rotationDisableAt: null });

    const row = repository.find(SERVER_ID, 'AK1');
    expect(row?.rotationReplacedBy).toBeNull();
    expect(row?.rotationDisableAt).toBeNull();
  });

  describe('dueExpiries', () => {
    beforeEach(() => {
      repository.upsert(SERVER_ID, 'past', {
        userName: 'alice',
        expiresAt: '2026-05-01T00:00:00.000Z',
      });
      repository.upsert(SERVER_ID, 'future', {
        userName: 'alice',
        expiresAt: '2027-05-01T00:00:00.000Z',
      });
      repository.upsert(SERVER_ID, 'none', { userName: 'alice' });
      repository.upsert(SERVER_ID, 'already', {
        userName: 'alice',
        expiresAt: '2026-05-01T00:00:00.000Z',
        status: 'expired',
      });
    });

    it('returns only keys past their date that are not marked expired yet', () => {
      const due = repository.dueExpiries('2026-06-01T00:00:00.000Z');

      expect(due.map((row) => row.accessKeyId)).toEqual(['past']);
    });

    it('stops returning a key once it is marked expired, so it is announced once', () => {
      repository.upsert(SERVER_ID, 'past', { status: 'expired' });

      expect(repository.dueExpiries('2026-06-01T00:00:00.000Z')).toHaveLength(0);
    });
  });

  it('returns rotations whose grace period has passed, and no others', () => {
    repository.upsert(SERVER_ID, 'old', {
      userName: 'alice',
      rotationReplacedBy: 'new',
      rotationDisableAt: '2026-05-31T23:00:00.000Z',
    });
    repository.upsert(SERVER_ID, 'waiting', {
      userName: 'alice',
      rotationReplacedBy: 'new2',
      rotationDisableAt: '2026-06-02T00:00:00.000Z',
    });
    repository.upsert(SERVER_ID, 'plain', { userName: 'alice' });

    const due = repository.dueRotations('2026-06-01T00:00:00.000Z');

    expect(due.map((row) => row.accessKeyId)).toEqual(['old']);
  });

  describe('expiringSoon', () => {
    const now = '2026-06-01T00:00:00.000Z';
    const until = '2026-06-08T00:00:00.000Z';

    beforeEach(() => {
      repository.upsert(SERVER_ID, 'soon', {
        userName: 'alice',
        expiresAt: '2026-06-03T00:00:00.000Z',
      });
      repository.upsert(SERVER_ID, 'later', {
        userName: 'alice',
        expiresAt: '2026-07-03T00:00:00.000Z',
      });
      repository.upsert(SERVER_ID, 'gone', {
        userName: 'alice',
        expiresAt: '2026-05-03T00:00:00.000Z',
      });
    });

    it('returns keys inside the window and neither side of it', () => {
      const soon = repository.expiringSoon(now, until);

      expect(soon.map((row) => row.accessKeyId)).toEqual(['soon']);
    });

    it('does not return a key that has already been announced', () => {
      repository.upsert(SERVER_ID, 'soon', { expiryNotifiedAt: now });

      expect(repository.expiringSoon(now, until)).toHaveLength(0);
    });

    it('still lists an announced key for the dashboard', () => {
      repository.upsert(SERVER_ID, 'soon', { expiryNotifiedAt: now });

      expect(repository.expiringWithin(now, until).map((row) => row.accessKeyId)).toEqual(['soon']);
    });
  });

  describe('pruneMissing', () => {
    beforeEach(() => {
      repository.upsert(SERVER_ID, 'AK1', { userName: 'alice' });
      repository.upsert(SERVER_ID, 'AK2', { userName: 'bob' });
      repository.upsert(SERVER_ID, 'AK3', { userName: 'bob' });
    });

    it('drops only the rows whose key the provider no longer has', () => {
      const removed = repository.pruneMissing(SERVER_ID, ['AK1', 'AK3']);

      expect(removed).toBe(1);
      expect(repository.find(SERVER_ID, 'AK2')).toBeNull();
      expect(repository.find(SERVER_ID, 'AK1')).not.toBeNull();
    });

    it('drops every row when the provider has no keys left', () => {
      expect(repository.pruneMissing(SERVER_ID, [])).toBe(3);
      expect(repository.byServer(SERVER_ID).size).toBe(0);
    });
  });

  it('deletes every row for one user', () => {
    repository.upsert(SERVER_ID, 'AK1', { userName: 'alice' });
    repository.upsert(SERVER_ID, 'AK2', { userName: 'bob' });

    repository.deleteByUser(SERVER_ID, 'alice');

    expect(repository.find(SERVER_ID, 'AK1')).toBeNull();
    expect(repository.find(SERVER_ID, 'AK2')).not.toBeNull();
  });

  it('goes away with its server, through the foreign key', () => {
    repository.upsert(SERVER_ID, 'AK1', { userName: 'alice' });

    db.delete(servers).run();

    expect(repository.byServer(SERVER_ID).size).toBe(0);
  });
});

/** Migrations log a line per run; a unit test does not need thirteen of them. */
function silentLogger(): Logger {
  const logger = new Logger('test');
  logger.log = () => undefined;
  return logger;
}
