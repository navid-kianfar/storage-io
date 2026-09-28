import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { JsonObject, PolicyVersion } from '@storage-io/contracts';
import { DB } from '../../db/db.module';
import type { AppDatabase } from '../../db/migrate';
import { policyVersions, type PolicyVersionRow } from '../../db/schema';
import { CryptoService } from '../../crypto/crypto.service';

/**
 * Snapshots of a policy document, one per `PUT` made through storage-io.
 *
 * MinIO keeps no history of a canned policy and IAM keeps at most five versions,
 * so this is what makes "undo that edit" possible on either. Only edits made here
 * are recorded — a policy changed with `mc` or the AWS console leaves no snapshot,
 * which is why the list is described as storage-io's history rather than the
 * server's.
 */

/** Enough to roll back a bad afternoon without growing without bound. */
const MAX_VERSIONS_PER_POLICY = 20;

@Injectable()
export class PolicyVersionRepository {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    private readonly crypto: CryptoService,
  ) {}

  /** Records a snapshot and trims the oldest beyond the cap, in one transaction. */
  record(serverId: string, policyName: string, document: JsonObject, note: string | null): void {
    this.db.transaction((tx) => {
      tx.insert(policyVersions)
        .values({
          id: this.crypto.newId(),
          serverId,
          policyName,
          document,
          note,
          createdAt: new Date().toISOString(),
        })
        .run();

      const kept = tx
        .select({ id: policyVersions.id })
        .from(policyVersions)
        .where(
          and(eq(policyVersions.serverId, serverId), eq(policyVersions.policyName, policyName)),
        )
        .orderBy(desc(policyVersions.createdAt))
        .limit(MAX_VERSIONS_PER_POLICY)
        .all();

      // SQLite has no `DELETE … LIMIT`, so the survivors are named and everything
      // else for this policy goes in one statement.
      const survivors = kept.map((row) => row.id);
      if (survivors.length < MAX_VERSIONS_PER_POLICY) return;

      tx.delete(policyVersions)
        .where(
          and(
            eq(policyVersions.serverId, serverId),
            eq(policyVersions.policyName, policyName),
            notInArray(policyVersions.id, survivors),
          ),
        )
        .run();
    });
  }

  list(serverId: string, policyName: string): readonly PolicyVersion[] {
    const rows = this.db
      .select()
      .from(policyVersions)
      .where(and(eq(policyVersions.serverId, serverId), eq(policyVersions.policyName, policyName)))
      .orderBy(desc(policyVersions.createdAt))
      .all();
    return rows.map(toContract);
  }

  find(serverId: string, policyName: string, id: string): PolicyVersion | null {
    const [row] = this.db
      .select()
      .from(policyVersions)
      .where(
        and(
          eq(policyVersions.serverId, serverId),
          eq(policyVersions.policyName, policyName),
          eq(policyVersions.id, id),
        ),
      )
      .limit(1)
      .all();
    return row === undefined ? null : toContract(row);
  }

  /** The most recent stored description, which no provider keeps for us. */
  latestNote(serverId: string, policyName: string): string | null {
    const [row] = this.db
      .select({ note: policyVersions.note })
      .from(policyVersions)
      .where(and(eq(policyVersions.serverId, serverId), eq(policyVersions.policyName, policyName)))
      .orderBy(desc(policyVersions.createdAt))
      .limit(1)
      .all();
    return row?.note ?? null;
  }

  /** When storage-io last wrote this policy — the `updatedAt` the UI shows. */
  lastWrittenAt(serverId: string, policyName: string): string | null {
    const [row] = this.db
      .select({ createdAt: policyVersions.createdAt })
      .from(policyVersions)
      .where(and(eq(policyVersions.serverId, serverId), eq(policyVersions.policyName, policyName)))
      .orderBy(desc(policyVersions.createdAt))
      .limit(1)
      .all();
    return row?.createdAt ?? null;
  }

  /** Every policy on one server that storage-io has written, with its metadata. */
  metadataByServer(
    serverId: string,
  ): ReadonlyMap<string, { readonly note: string | null; readonly updatedAt: string }> {
    const rows = this.db
      .select({
        policyName: policyVersions.policyName,
        note: policyVersions.note,
        createdAt: policyVersions.createdAt,
      })
      .from(policyVersions)
      .where(eq(policyVersions.serverId, serverId))
      .orderBy(desc(policyVersions.createdAt))
      .all();

    const latest = new Map<string, { note: string | null; updatedAt: string }>();
    for (const row of rows) {
      // Ordered newest first, so the first row per policy is the one to keep.
      if (latest.has(row.policyName)) continue;
      latest.set(row.policyName, { note: row.note, updatedAt: row.createdAt });
    }
    return latest;
  }

  deleteForPolicy(serverId: string, policyName: string): void {
    this.db
      .delete(policyVersions)
      .where(and(eq(policyVersions.serverId, serverId), eq(policyVersions.policyName, policyName)))
      .run();
  }
}

/* ------------------------------ helpers --------------------------- */

const toContract = (row: PolicyVersionRow): PolicyVersion => ({
  id: row.id,
  createdAt: row.createdAt,
  document: row.document,
  note: row.note,
});
