import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  SETTINGS_DEFAULTS,
  settingsSchema,
  type NotificationChannel,
  type NotificationRule,
  type NotificationRules,
  type NotificationSettings,
  type Settings,
  type UpdateSettingsRequest,
} from '@storage-io/contracts';
import { DB } from '../db/db.module';
import type { AppDatabase } from '../db/migrate';
import { settings as settingsTable } from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';

/**
 * Secrets inside Settings: accepted on PATCH, never returned, and never stored
 * in the clear.
 *
 * They are the same three paths for both rules on purpose — a value worth hiding
 * from a response is a value worth encrypting in the file, and keeping two lists
 * is how one of them ends up a field behind.
 */
const SECRET_FIELDS = [
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
export class SettingsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SettingsService.name);
  private cached: Settings | null = null;

  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Brings a database written before secrets were encrypted up to date.
   *
   * Idempotent by construction: a leaf that already decrypts is left alone, so
   * the pass costs one read and no write on every boot after the first. It
   * belongs at bootstrap rather than in a SQL migration because the ciphertext
   * depends on `APP_SECRET`, which a migration file cannot reach.
   */
  onApplicationBootstrap(): void {
    this.encryptStoredSecrets();
  }

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

    this.cached = this.mapSecrets(parsed.data, (value) => this.decryptStoredSecret(value));
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
    const atRest = this.mapSecrets(parsed.data, (value) => this.crypto.encryptSecret(value));

    this.db.transaction((tx) => {
      for (const section of touched) {
        const value = atRest[section] as Record<string, unknown>;
        tx.insert(settingsTable)
          .values({ section, value, updatedAt })
          .onConflictDoUpdate({ target: settingsTable.section, set: { value, updatedAt } })
          .run();
      }
    });

    this.cached = parsed.data;
    return stripWriteOnly(parsed.data);
  }

  /**
   * Clears one delivery channel: its configuration, its write-only secret, and
   * every rule that routed to it.
   *
   * A PATCH cannot express this. `deepMerge` keeps any key the caller leaves
   * out — which is exactly what makes an omitted secret mean "leave the stored
   * one alone" — so no request body can remove a saved password, and the
   * channel's own form will not save an empty host or URL either. Hence a
   * verb of its own rather than a flag on update().
   *
   * The rules column is cleared with it, deliberately: a tick left behind on a
   * disconnected channel starts delivering again the moment someone connects a
   * different URL under the same name, which is the one failure mode an
   * operator would never think to check for.
   */
  removeNotificationChannel(channel: NotificationChannel): Settings {
    const current = this.getInternal();

    const clearedRuleEntries = Object.entries(current.notifications.rules).map(([key, rule]) => {
      const withoutChannel: NotificationRule = { ...rule, [channel]: false };
      return [key, withoutChannel] as const;
    });
    const rules = Object.fromEntries(clearedRuleEntries) as NotificationRules;

    // The defaults carry no secret key at all, so the stored leaf goes away
    // rather than becoming an empty string that still reads as "configured".
    const blank = structuredClone(SETTINGS_DEFAULTS.notifications[channel]);
    const notifications: NotificationSettings = {
      ...current.notifications,
      [channel]: blank,
      rules,
    };
    const next: Settings = { ...current, notifications };

    const parsed = settingsSchema.safeParse(next);
    if (!parsed.success) {
      throw new Error(`Clearing ${channel} produced an invalid document: ${parsed.error.message}`);
    }

    const updatedAt = new Date().toISOString();
    const atRest = this.mapSecrets(parsed.data, (value) => this.crypto.encryptSecret(value));
    const value = atRest.notifications as unknown as Record<string, unknown>;

    this.db
      .insert(settingsTable)
      .values({ section: 'notifications', value, updatedAt })
      .onConflictDoUpdate({ target: settingsTable.section, set: { value, updatedAt } })
      .run();

    this.cached = parsed.data;
    this.logger.log({ channel }, 'Notification channel disconnected and its secret cleared');
    return stripWriteOnly(parsed.data);
  }

  /**
   * Replaces every section, for a configuration import. A merge would be wrong
   * here: restoring a backup means the configuration in the file, not the file's
   * values layered over whatever this install had drifted to — and a merge cannot
   * express "this section had nothing set".
   *
   * One transaction, so a failed import cannot leave half the sections restored.
   */
  replaceAll(next: Settings): Settings {
    const parsed = settingsSchema.safeParse(next);
    if (!parsed.success) {
      throw new Error(`The imported settings are not valid: ${parsed.error.message}`);
    }

    const updatedAt = new Date().toISOString();
    const atRest = this.mapSecrets(parsed.data, (value) => this.crypto.encryptSecret(value));
    this.db.transaction((tx) => {
      for (const section of SECTIONS) {
        const value = atRest[section] as Record<string, unknown>;
        tx.insert(settingsTable)
          .values({ section, value, updatedAt })
          .onConflictDoUpdate({ target: settingsTable.section, set: { value, updatedAt } })
          .run();
      }
    });

    this.cached = parsed.data;
    this.logger.log({ sections: SECTIONS.length }, 'Settings replaced from a configuration import');
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

  /* ---------------------------- secrets at rest -------------------- */

  /**
   * A copy of the document with every secret leaf run through `transform`.
   *
   * One walk serves both directions — encrypting on the way into the database and
   * decrypting on the way out — because a second copy of the path list is how the
   * two ends drift apart. An empty leaf is left alone: `''` means the operator
   * cleared the secret, and encrypting it would turn "no secret" into a blob that
   * reads back as one.
   */
  private mapSecrets(document: Settings, transform: (value: string) => string): Settings {
    const clone = structuredClone(document) as unknown as Record<string, unknown>;
    for (const path of SECRET_FIELDS) {
      const current = readLeaf(clone, path);
      if (current === null || current.length === 0) continue;
      writeLeaf(clone, path, transform(current));
    }
    return clone as unknown as Settings;
  }

  /**
   * The plaintext behind a stored leaf. A value that will not decrypt is a row
   * written before this became the rule (or hand-edited), and is returned as it
   * stands so a notification channel keeps working until the boot pass rewrites
   * it — the alternative is an operator's SMTP password silently becoming
   * gibberish on upgrade.
   */
  private decryptStoredSecret(stored: string): string {
    try {
      return this.crypto.decryptSecret(stored);
    } catch {
      return stored;
    }
  }

  private isEncrypted(stored: string): boolean {
    try {
      this.crypto.decryptSecret(stored);
      return true;
    } catch {
      return false;
    }
  }

  /** The upgrade pass; see `onApplicationBootstrap`. */
  private encryptStoredSecrets(): void {
    const sections = new Set(SECRET_FIELDS.map((path) => path[0] as SettingsSection));
    const rewritten: { section: SettingsSection; value: Record<string, unknown> }[] = [];

    for (const section of sections) {
      const [row] = this.db
        .select()
        .from(settingsTable)
        .where(eq(settingsTable.section, section))
        .limit(1)
        .all();
      if (row === undefined) continue;

      const value = structuredClone(row.value);
      let changed = false;
      for (const path of SECRET_FIELDS) {
        if (path[0] !== section) continue;
        // The row holds the section's own tree, so the section name is not part
        // of the path inside it.
        const leafPath = path.slice(1);
        const stored = readLeaf(value, leafPath);
        if (stored === null || stored.length === 0) continue;
        if (this.isEncrypted(stored)) continue;
        writeLeaf(value, leafPath, this.crypto.encryptSecret(stored));
        changed = true;
      }
      if (changed) rewritten.push({ section, value });
    }

    if (rewritten.length === 0) return;

    const updatedAt = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const entry of rewritten) {
        tx.update(settingsTable)
          .set({ value: entry.value, updatedAt })
          .where(eq(settingsTable.section, entry.section))
          .run();
      }
    });
    this.cached = null;
    this.logger.log(
      { sections: rewritten.map((entry) => entry.section) },
      'Encrypted notification secrets that were stored in the clear',
    );
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
  for (const path of SECRET_FIELDS) {
    const parent = parentOf(clone, path);
    if (parent === null) continue;
    delete parent[path[path.length - 1] as string];
  }
  return clone as unknown as Settings;
}

/** The object holding the path's last segment, or `null` when the path is absent. */
function parentOf(
  root: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | null {
  let cursor: Record<string, unknown> = root;
  for (const segment of path.slice(0, -1)) {
    const next: unknown = cursor[segment];
    if (!isPlainObject(next)) return null;
    cursor = next;
  }
  return cursor;
}

/** The string at `path`, or `null` when it is absent or not a string. */
function readLeaf(root: Record<string, unknown>, path: readonly string[]): string | null {
  const parent = parentOf(root, path);
  if (parent === null) return null;
  const value: unknown = parent[path[path.length - 1] as string];
  return typeof value === 'string' ? value : null;
}

function writeLeaf(root: Record<string, unknown>, path: readonly string[], value: string): void {
  const parent = parentOf(root, path);
  if (parent === null) return;
  parent[path[path.length - 1] as string] = value;
}
