import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, lt, ne } from 'drizzle-orm';
import type { AuthSession } from '@storage-io/contracts';
import { DB } from '../db/db.module';
import type { AppDatabase } from '../db/migrate';
import { sessions } from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';

const REMEMBER_TTL_HOURS = 30 * 24;
/** `lastSeenAt` is only rewritten this often, to keep a read path read-mostly. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

export interface CreatedSession {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly maxAgeMs: number;
}

export interface ResolvedSession {
  readonly id: string;
  readonly expiresAt: string;
}

/**
 * Opaque session tokens: 32 random bytes handed to the browser, only their
 * SHA-256 stored. That is what makes a session list and revocation possible —
 * a signed stateless cookie could be listed but never revoked.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    private readonly crypto: CryptoService,
    private readonly settings: SettingsService,
  ) {}

  create(options: {
    readonly remember: boolean;
    readonly userAgent: string | null;
    readonly ip: string | null;
  }): CreatedSession {
    const { token, hash } = this.crypto.generateSessionToken();
    const ttlHours = options.remember ? REMEMBER_TTL_HOURS : this.settings.sessionTtlHours;
    const now = new Date();
    const expires = new Date(now.getTime() + ttlHours * 3600_000);
    const id = this.crypto.newId();

    this.db
      .insert(sessions)
      .values({
        id,
        tokenHash: hash,
        userAgent: options.userAgent,
        ip: options.ip,
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: expires.toISOString(),
      })
      .run();

    return {
      id,
      token,
      expiresAt: expires.toISOString(),
      maxAgeMs: expires.getTime() - now.getTime(),
    };
  }

  /**
   * `null` for an unknown or expired token. An expired row is deleted on sight
   * rather than left for the sweeper, so a replayed cookie stops working at once.
   */
  resolve(token: string): ResolvedSession | null {
    const hash = this.crypto.hashToken(token);
    const [row] = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hash))
      .limit(1)
      .all();
    if (row === undefined) return null;

    const now = Date.now();
    if (Date.parse(row.expiresAt) <= now) {
      this.db.delete(sessions).where(eq(sessions.id, row.id)).run();
      return null;
    }

    const lastSeen = row.lastSeenAt === null ? 0 : Date.parse(row.lastSeenAt);
    if (now - lastSeen > LAST_SEEN_WRITE_INTERVAL_MS) {
      this.db
        .update(sessions)
        .set({ lastSeenAt: new Date(now).toISOString() })
        .where(eq(sessions.id, row.id))
        .run();
    }

    return { id: row.id, expiresAt: row.expiresAt };
  }

  list(currentSessionId: string | null): readonly AuthSession[] {
    const rows = this.db.select().from(sessions).all();
    return rows
      .map((row) => ({
        id: row.id,
        userAgent: row.userAgent,
        ip: row.ip,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
        current: row.id === currentSessionId,
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** True when a row was removed, so the controller can answer 404 otherwise. */
  revoke(sessionId: string): boolean {
    const result = this.db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    return result.changes > 0;
  }

  /** One set-based delete, not a read-then-loop. */
  revokeOthers(currentSessionId: string): number {
    const result = this.db.delete(sessions).where(ne(sessions.id, currentSessionId)).run();
    return result.changes;
  }

  /**
   * Every session, for the caller that has none of its own — an API token
   * revoking "the others" means all of them. One statement, because listing the
   * rows only to delete them one by one is a round trip per session and is not
   * atomic: a session created between the list and its delete would survive.
   */
  revokeAll(): number {
    const result = this.db.delete(sessions).run();
    return result.changes;
  }

  revokeByToken(token: string): void {
    const hash = this.crypto.hashToken(token);
    this.db.delete(sessions).where(eq(sessions.tokenHash, hash)).run();
  }

  /** Called by the maintenance schedule; also safe to call at boot. */
  deleteExpired(): number {
    const now = new Date().toISOString();
    const result = this.db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
    if (result.changes > 0) {
      this.logger.log(`Removed ${result.changes} expired session(s)`);
    }
    return result.changes;
  }

  /** True when this user agent / IP pair has not been seen before — new device. */
  isNewDevice(userAgent: string | null, ip: string | null): boolean {
    if (userAgent === null && ip === null) return false;
    const rows = this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          userAgent === null ? undefined : eq(sessions.userAgent, userAgent),
          ip === null ? undefined : eq(sessions.ip, ip),
        ),
      )
      .limit(1)
      .all();
    return rows.length === 0;
  }
}
