import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyMigrations, createDatabase, type AppDatabase } from '../../src/db/migrate';
import { servers } from '../../src/db/schema';
import type { CryptoService } from '../../src/crypto/crypto.service';
import { IamEntityRepository } from '../../src/modules/iam-core/iam-entity.repository';
import { InventoryRepository } from '../../src/modules/inventory/inventory.repository';

/**
 * The opaque ids a URL carries, against a real file database.
 *
 * Both registries promise the same two things, and both promises are only
 * interesting across a **restart**: an id is stable however often the entity is
 * listed, and it survives the process that issued it. So these tests close the
 * database handle and open it again rather than reusing one in memory — an
 * in-memory database would prove the map inside one process and nothing about
 * the row on disk.
 *
 * The third property is the deliberate limit of the first two: an entity that is
 * deleted and created again **may** get a new id. For a bucket it always does —
 * the cache row is gone — and for an IAM entity it does not, because the registry
 * row outlives the entity. Both are recorded here so neither reads as a bug
 * later.
 *
 * No container: this spec needs nothing but SQLite, so it runs in every `pnpm
 * test`.
 */

const SERVER_ID = 'server-ids-1';
const OTHER_SERVER_ID = 'server-ids-2';

const crypto = { newId: (): string => randomUUID() } as CryptoService;

const seedServer = (db: AppDatabase, id: string, name: string): void => {
  const now = new Date().toISOString();
  db.insert(servers)
    .values({
      id,
      name,
      provider: 'minio',
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretEncrypted: 'v1.a.b.c',
      createdAt: now,
      updatedAt: now,
    })
    .run();
};

describe('opaque ids across a restart', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sio-ids-'));
    path = join(directory, 'ids.sqlite');

    const first = createDatabase(path);
    try {
      applyMigrations(first.db);
      seedServer(first.db, SERVER_ID, 'minio-lab');
      seedServer(first.db, OTHER_SERVER_ID, 'minio-spare');
    } finally {
      first.client.close();
    }
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** One "process": open the file, run `use`, close it again. */
  const withDatabase = <T>(use: (db: AppDatabase) => T): T => {
    const opened = createDatabase(path);
    try {
      applyMigrations(opened.db);
      return use(opened.db);
    } finally {
      opened.client.close();
    }
  };

  describe('IAM entities', () => {
    it('gives the same id to the same name however often it is listed', () => {
      const ids = withDatabase((db) => {
        const registry = new IamEntityRepository(db, crypto);
        const first = registry.idsFor(SERVER_ID, 'user', ['alice', 'bob']);
        const second = registry.idsFor(SERVER_ID, 'user', ['alice', 'bob']);
        const third = registry.idFor(SERVER_ID, 'user', 'alice');
        return {
          first: Object.fromEntries(first),
          second: Object.fromEntries(second),
          third,
        };
      });

      expect(ids.second).toEqual(ids.first);
      expect(ids.third).toBe(ids.first['alice']);
    });

    it('keeps the id across a restart', () => {
      const before = withDatabase((db) => {
        const registry = new IamEntityRepository(db, crypto);
        return registry.idFor(SERVER_ID, 'user', 'alice');
      });

      const after = withDatabase((db) => {
        const registry = new IamEntityRepository(db, crypto);
        return registry.idFor(SERVER_ID, 'user', 'alice');
      });

      expect(after).toBe(before);
    });

    it('resolves an id back to the server and name it was issued for', () => {
      const resolved = withDatabase((db) => {
        const registry = new IamEntityRepository(db, crypto);
        const id = registry.idFor(SERVER_ID, 'key', 'AKIA0000000000000001');
        return registry.find(id);
      });

      expect(resolved).toEqual({
        id: expect.any(String),
        serverId: SERVER_ID,
        kind: 'key',
        name: 'AKIA0000000000000001',
      });
    });

    it('answers null for an id it never issued', () => {
      const resolved = withDatabase((db) => {
        const registry = new IamEntityRepository(db, crypto);
        return registry.find(randomUUID());
      });

      expect(resolved).toBeNull();
    });

    it('keeps names on different servers, and different kinds, apart', () => {
      const ids = withDatabase((db) => {
        const registry = new IamEntityRepository(db, crypto);
        return {
          user: registry.idFor(SERVER_ID, 'user', 'shared'),
          otherServer: registry.idFor(OTHER_SERVER_ID, 'user', 'shared'),
          group: registry.idFor(SERVER_ID, 'group', 'shared'),
        };
      });

      expect(new Set([ids.user, ids.otherServer, ids.group]).size).toBe(3);
    });

    /**
     * The registry is not a mirror: nothing deletes a row when the entity goes,
     * so recreating a user under the same name resolves to the id every link to
     * it was built from. Deleting the *server* is what releases the ids.
     */
    it('releases an id only when the server itself is deleted', () => {
      const first = withDatabase((db) => {
        const registry = new IamEntityRepository(db, crypto);
        return registry.idFor(SERVER_ID, 'user', 'temporary');
      });

      const afterServerDeleted = withDatabase((db) => {
        db.delete(servers).where(eq(servers.id, SERVER_ID)).run();
        seedServer(db, SERVER_ID, 'minio-lab');
        const registry = new IamEntityRepository(db, crypto);
        return registry.idFor(SERVER_ID, 'user', 'temporary');
      });

      expect(afterServerDeleted).not.toBe(first);
    });
  });

  describe('buckets', () => {
    it('gives a cached bucket one id and keeps it across a restart and a refresh', () => {
      const first = withDatabase((db) => {
        const inventory = new InventoryRepository(db, crypto);
        inventory.upsert(SERVER_ID, [{ name: 'reports', sizeBytes: 10 }]);
        return inventory.findOne(SERVER_ID, 'reports')?.id;
      });

      const afterRefresh = withDatabase((db) => {
        const inventory = new InventoryRepository(db, crypto);
        // What the refresher does on every sweep.
        inventory.upsert(SERVER_ID, [{ name: 'reports', sizeBytes: 20 }]);
        return inventory.findOne(SERVER_ID, 'reports')?.id;
      });

      expect(first).toEqual(expect.any(String));
      expect(afterRefresh).toBe(first);
    });

    it('resolves a bucket id back to its server and name', () => {
      const located = withDatabase((db) => {
        const inventory = new InventoryRepository(db, crypto);
        inventory.upsert(SERVER_ID, [{ name: 'reports' }]);
        const id = inventory.idOf(SERVER_ID, 'reports');
        return inventory.locate(id as string);
      });

      expect(located).toEqual({ serverId: SERVER_ID, name: 'reports' });
    });

    /**
     * A bucket's id lives on its cache row, so deleting the bucket releases it.
     * That is the honest answer — a bucket created again is not the one the link
     * pointed at — and it is what the contract warns about.
     */
    it('gives a deleted and recreated bucket a new id', () => {
      const before = withDatabase((db) => {
        const inventory = new InventoryRepository(db, crypto);
        inventory.upsert(SERVER_ID, [{ name: 'scratch' }]);
        return inventory.idOf(SERVER_ID, 'scratch');
      });

      const after = withDatabase((db) => {
        const inventory = new InventoryRepository(db, crypto);
        inventory.remove(SERVER_ID, 'scratch');
        inventory.upsert(SERVER_ID, [{ name: 'scratch' }]);
        return inventory.idOf(SERVER_ID, 'scratch');
      });

      expect(after).toEqual(expect.any(String));
      expect(after).not.toBe(before);
    });

    it('answers null for a bucket id it never issued', () => {
      const located = withDatabase((db) => {
        const inventory = new InventoryRepository(db, crypto);
        return inventory.locate(randomUUID());
      });

      expect(located).toBeNull();
    });
  });
});
