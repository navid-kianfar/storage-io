import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { QUOTA_THRESHOLD_DEFAULT, type Quota, type QuotaMode } from '@storage-io/contracts';
import { DB } from '../../db/db.module';
import type { AppDatabase } from '../../db/migrate';
import { quotas } from '../../db/schema';

/** Thresholds are stored in permille so the column stays an integer. */
const PERMILLE = 1000;

export interface StoredQuota extends Quota {
  readonly serverId: string;
  readonly bucket: string;
  /** When the threshold alert last fired; cleared once usage drops back under. */
  readonly alertedAt: string | null;
}

export interface SetQuotaInput {
  readonly limitBytes: number;
  readonly mode: QuotaMode;
  readonly threshold: number;
  /** True when the provider enforces it too, not only storage-io. */
  readonly native: boolean;
}

/**
 * The quota storage-io keeps for itself.
 *
 * It exists even when the provider has a native quota, for two reasons: the
 * `threshold` that drives the alert has no native equivalent anywhere, and the
 * quotas page has to list every bucket that has a limit without asking each
 * server. `native` records whether the provider is enforcing the limit as well.
 */
@Injectable()
export class QuotaRepository {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  find(serverId: string, bucket: string): StoredQuota | null {
    const [row] = this.db
      .select()
      .from(quotas)
      .where(and(eq(quotas.serverId, serverId), eq(quotas.bucket, bucket)))
      .limit(1)
      .all();
    return row === undefined ? null : toStoredQuota(row);
  }

  set(serverId: string, bucket: string, input: SetQuotaInput): StoredQuota {
    const updatedAt = new Date().toISOString();
    const values = {
      serverId,
      bucket,
      limitBytes: input.limitBytes,
      mode: input.mode,
      threshold: Math.round(input.threshold * PERMILLE),
      native: input.native,
      updatedAt,
    };

    this.db
      .insert(quotas)
      .values(values)
      .onConflictDoUpdate({
        target: [quotas.serverId, quotas.bucket],
        set: {
          limitBytes: values.limitBytes,
          mode: values.mode,
          threshold: values.threshold,
          native: values.native,
          // A new limit is a new situation: the previous crossing must not
          // suppress the alert for this one.
          alertedAt: null,
          updatedAt,
        },
      })
      .run();

    const stored = this.find(serverId, bucket);
    if (stored === null) throw new Error('The quota upsert returned no row.');
    return stored;
  }

  remove(serverId: string, bucket: string): boolean {
    const result = this.db
      .delete(quotas)
      .where(and(eq(quotas.serverId, serverId), eq(quotas.bucket, bucket)))
      .run();
    return result.changes > 0;
  }

  /** Every quota, for the watcher — one query, then one pass over the rows. */
  all(): readonly StoredQuota[] {
    return this.db.select().from(quotas).all().map(toStoredQuota);
  }

  /** Quotas whose threshold alert has fired, so a recovery can clear it. */
  alerted(): readonly StoredQuota[] {
    return this.db
      .select()
      .from(quotas)
      .where(isNotNull(quotas.alertedAt))
      .all()
      .map(toStoredQuota);
  }

  markAlerted(serverId: string, bucket: string): void {
    this.db
      .update(quotas)
      .set({ alertedAt: new Date().toISOString() })
      .where(and(eq(quotas.serverId, serverId), eq(quotas.bucket, bucket)))
      .run();
  }

  clearAlert(serverId: string, bucket: string): void {
    this.db
      .update(quotas)
      .set({ alertedAt: null })
      .where(and(eq(quotas.serverId, serverId), eq(quotas.bucket, bucket)))
      .run();
  }
}

/* ------------------------------ mapping --------------------------- */

interface QuotaRow {
  readonly serverId: string;
  readonly bucket: string;
  readonly limitBytes: number;
  readonly mode: string;
  readonly threshold: number;
  readonly native: boolean;
  readonly alertedAt: string | null;
}

function toStoredQuota(row: QuotaRow): StoredQuota {
  return {
    serverId: row.serverId,
    bucket: row.bucket,
    limitBytes: row.limitBytes,
    mode: row.mode as QuotaMode,
    threshold: row.threshold === 0 ? QUOTA_THRESHOLD_DEFAULT : row.threshold / PERMILLE,
    native: row.native,
    alertedAt: row.alertedAt,
  };
}
