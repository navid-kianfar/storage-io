import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  SETTINGS_DEFAULTS,
  settingsSchema,
  type Settings,
  type UpdateSettingsRequest,
} from '@storage-io/contracts';
import { DB } from '../db/db.module';
import type { AppDatabase } from '../db/migrate';
import { settings as settingsTable } from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';

/** Secrets inside Settings: accepted on PATCH, never returned. */
const WRITE_ONLY_FIELDS = [
  ['notifications', 'email', 'password'],
  ['notifications', 'webhook', 'secret'],
  ['notifications', 'telegram', 'botToken'],
] as const satisfies readonly (readonly string[])[];

type SettingsSection = keyof Settings;

const SECTIONS = Object.keys(SETTINGS_DEFAULTS) as readonly SettingsSection[];

/**
 * Settings live one row per top-level section, so a PATCH of `health` is one
 * upsert and never races a concurrent PATCH of `notifications`.
 *
 * Read paths are hot (the guard, the health checker and the notification router
 * all ask on every pass), so the merged document is cached and the cache is
 * dropped on every write. The cache is process-local, which is correct here: the
 * API is a single process by design.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cached: Settings | null = null;

  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    private readonly crypto: CryptoService,
  ) {}

  /** The full document with defaults filled in — secrets included. Internal use. */
  getInternal(): Settings {
    if (this.cached !== null) return this.cached;

    const rows = this.db.select().from(settingsTable).all();
    const stored = new Map(rows.map((row) => [row.section, row.value]));

    const merged = Object.fromEntries(
      SECTIONS.map((section) => [
        section,
        deepMerge(SETTINGS_DEFAULTS[section], stored.get(section)),
      ]),
    );

    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) {
      // A stored section that no longer validates (a downgrade, a hand-edited
      // row) must not take the API down: fall back to defaults and say so.
      this.logger.error(
        { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
        'Stored settings failed validation; using defaults for the whole document',
      );
      this.cached = SETTINGS_DEFAULTS;
      return this.cached;
    }

    this.cached = parsed.data;
    return this.cached;
  }

  /** What `GET /settings` returns: the document with every secret removed. */
  getPublic(): Settings {
    return stripWriteOnly(this.getInternal());
  }

  /**
   * Applies a partial tree, section by section, inside one transaction so a
   * multi-section PATCH cannot land half-applied.
   */
  update(patch: UpdateSettingsRequest): Settings {
    const current = this.getInternal();
    const next = deepMerge(current, patch);

    const parsed = settingsSchema.safeParse(next);
    if (!parsed.success) {
      // The DTO already validated each field; reaching here means the merge
      // produced something invalid, which is a bug rather than bad input.
      throw new Error(`Settings merge produced an invalid document: ${parsed.error.message}`);
    }

    const updatedAt = new Date().toISOString();
    const touched = Object.keys(patch) as readonly SettingsSection[];

    this.db.transaction((tx) => {
      for (const section of touched) {
        const value = parsed.data[section] as Record<string, unknown>;
        tx.insert(settingsTable)
          .values({ section, value, updatedAt })
          .onConflictDoUpdate({ target: settingsTable.section, set: { value, updatedAt } })
          .run();
      }
    });

    this.cached = parsed.data;
    return stripWriteOnly(parsed.data);
  }

  /** Used by `PATCH /auth/me`, which writes into the profile section. */
  updateProfile(profile: Partial<Settings['profile']>): Settings['profile'] {
    const updated = this.update({ profile });
    return updated.profile;
  }

  /** Cheap accessors the hot paths use instead of reading the whole document. */
  get allowedNetworks(): readonly string[] {
    return this.getInternal().security.allowedNetworks;
  }

  get sessionTtlHours(): number {
    return this.getInternal().security.sessionTtlHours;
  }

  get latencyWarnMs(): number {
    return this.getInternal().health.latencyWarnMs;
  }

  get defaultHealthIntervalSec(): number {
    return this.getInternal().health.defaultIntervalSec;
  }

  /** Forget the cache — for tests, and after a settings import. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Secrets are stored encrypted, like server credentials: a settings row is as
   * readable as any other table to anyone with the file.
   */
  encryptSecretValue(plaintext: string): string {
    return this.crypto.encryptSecret(plaintext);
  }

  decryptSecretValue(envelope: string): string {
    return this.crypto.decryptSecret(envelope);
  }

  /** True when the section row exists — used by the first-run wizard. */
  hasBeenConfigured(): boolean {
    const rows = this.db
      .select({ section: settingsTable.section })
      .from(settingsTable)
      .where(eq(settingsTable.section, 'profile'))
      .limit(1)
      .all();
    return rows.length > 0;
  }
}

/* ------------------------------ helpers --------------------------- */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Merges `patch` onto `base` recursively. An array replaces wholesale — a
 * merged `allowedNetworks` or `to` list would make "remove an entry"
 * impossible to express.
 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    result[key] = deepMerge(result[key], value);
  }
  return result as T;
}

function stripWriteOnly(value: Settings): Settings {
  const clone = structuredClone(value) as unknown as Record<string, unknown>;
  for (const path of WRITE_ONLY_FIELDS) {
    let cursor: Record<string, unknown> | undefined = clone;
    for (const segment of path.slice(0, -1)) {
      const next: unknown = cursor?.[segment];
      cursor = isPlainObject(next) ? next : undefined;
      if (cursor === undefined) break;
    }
    const leaf = path[path.length - 1] as string;
    if (cursor !== undefined) delete cursor[leaf];
  }
  return clone as unknown as Settings;
}
