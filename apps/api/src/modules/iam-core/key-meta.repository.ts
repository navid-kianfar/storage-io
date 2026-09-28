import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, lte, notInArray, sql } from 'drizzle-orm';
import { DB } from '../../db/db.module';
import type { AppDatabase } from '../../db/migrate';
import { keyMeta, type KeyMetaRow } from '../../db/schema';

/**
 * `key_meta`: what storage-io knows about an access key beyond what the provider
 * reports.
 *
 * Three things live here and nowhere else:
 *
 * - **An expiry on providers that have none.** MinIO service accounts expire by
 *   themselves; an IAM, RGW or Garage key does not, so the date is stored here and
 *   `KeyExpiryService` is what makes it mean anything.
 * - **A name**, for the same reason: IAM and RGW store none.
 * - **A rotation in flight** — the replacement key and when the old one is
 *   disabled — so a restart in the middle of a grace period does not lose it.
 *
 * All of the SQL for the table is in this file. Sweeps are set-based statements
 * rather than a loop of updates: a hundred expired keys is one `UPDATE`.
 */

export interface KeyMetaPatch {
  readonly userName?: string;
  readonly name?: string | null;
  readonly createdAt?: string | null;
  readonly expiresAt?: string | null;
  readonly lastUsedAt?: string | null;
  readonly status?: 'active' | 'disabled' | 'expired';
  readonly restricted?: boolean;
  readonly rotationReplacedBy?: string | null;
  readonly rotationDisableAt?: string | null;
  readonly expiryNotifiedAt?: string | null;
}

/** What a row looks like before any patch is applied to it. */
const NEW_ROW_DEFAULTS = {
  userName: '',
  name: null,
  createdAt: null,
  expiresAt: null,
  lastUsedAt: null,
  status: 'active',
  restricted: false,
  rotationReplacedBy: null,
  rotationDisableAt: null,
  expiryNotifiedAt: null,
} as const;

@Injectable()
export class KeyMetaRepository {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  find(serverId: string, accessKeyId: string): KeyMetaRow | null {
    const [row] = this.db
      .select()
      .from(keyMeta)
      .where(and(eq(keyMeta.serverId, serverId), eq(keyMeta.accessKeyId, accessKeyId)))
      .limit(1)
      .all();
    return row ?? null;
  }

  /** Every row for one server, keyed by access key id for a single-pass merge. */
  byServer(serverId: string): ReadonlyMap<string, KeyMetaRow> {
    const rows = this.db.select().from(keyMeta).where(eq(keyMeta.serverId, serverId)).all();
    return new Map(rows.map((row) => [row.accessKeyId, row]));
  }

  /**
   * Insert or merge. `undefined` fields are left as they are, so observing a key
   * during a list never overwrites an expiry the operator set.
   */
  upsert(serverId: string, accessKeyId: string, patch: KeyMetaPatch): void {
    const now = new Date().toISOString();

    // `KeyMetaPatch`'s keys are the column property names, so the set clause is
    // the patch with its absent fields dropped — one loop instead of a line per
    // column, which is also one fewer place to forget a new column.
    const changed: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      changed[column] = value;
    }

    this.db
      .insert(keyMeta)
      .values({ ...NEW_ROW_DEFAULTS, ...changed, serverId, accessKeyId, updatedAt: now })
      .onConflictDoUpdate({
        target: [keyMeta.serverId, keyMeta.accessKeyId],
        set: { ...changed, updatedAt: now },
      })
      .run();
  }

  delete(serverId: string, accessKeyId: string): void {
    this.db
      .delete(keyMeta)
      .where(and(eq(keyMeta.serverId, serverId), eq(keyMeta.accessKeyId, accessKeyId)))
      .run();
  }

  /** Every row for one user, for the user-delete path. */
  deleteByUser(serverId: string, userName: string): void {
    this.db
      .delete(keyMeta)
      .where(and(eq(keyMeta.serverId, serverId), eq(keyMeta.userName, userName)))
      .run();
  }

  /**
   * Drops rows for keys the provider no longer has. Called only after a *complete*
   * listing — pruning from a filtered one would delete every other user's rows.
   */
  pruneMissing(serverId: string, presentAccessKeyIds: readonly string[]): number {
    if (presentAccessKeyIds.length === 0) {
      return this.db.delete(keyMeta).where(eq(keyMeta.serverId, serverId)).run().changes;
    }
    return this.db
      .delete(keyMeta)
      .where(
        and(
          eq(keyMeta.serverId, serverId),
          notInArray(keyMeta.accessKeyId, [...presentAccessKeyIds]),
        ),
      )
      .run().changes;
  }

  /* ------------------------------ sweeps -------------------------- */

  /** Keys whose app-tracked expiry has passed and that are not marked expired yet. */
  dueExpiries(nowIso: string): readonly KeyMetaRow[] {
    return this.db
      .select()
      .from(keyMeta)
      .where(and(lte(keyMeta.expiresAt, nowIso), sql`${keyMeta.status} <> 'expired'`))
      .all();
  }

  /** Rotations whose grace period is over: the old key is disabled now. */
  dueRotations(nowIso: string): readonly KeyMetaRow[] {
    return this.db.select().from(keyMeta).where(lte(keyMeta.rotationDisableAt, nowIso)).all();
  }

  /** Keys expiring inside the window that have not been announced yet. */
  expiringSoon(nowIso: string, untilIso: string): readonly KeyMetaRow[] {
    return this.db
      .select()
      .from(keyMeta)
      .where(
        and(
          gt(keyMeta.expiresAt, nowIso),
          lte(keyMeta.expiresAt, untilIso),
          isNull(keyMeta.expiryNotifiedAt),
        ),
      )
      .all();
  }

  /** Keys expiring inside the window, announced or not — the dashboard's list. */
  expiringWithin(nowIso: string, untilIso: string): readonly KeyMetaRow[] {
    return this.db
      .select()
      .from(keyMeta)
      .where(and(gt(keyMeta.expiresAt, nowIso), lte(keyMeta.expiresAt, untilIso)))
      .orderBy(keyMeta.expiresAt)
      .all();
  }
}
