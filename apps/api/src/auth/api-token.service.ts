import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type {
  ApiToken,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
} from '@storage-io/contracts';
import { DB } from '../db/db.module';
import type { AppDatabase } from '../db/migrate';
import { apiTokens } from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import { ConflictError } from '../common/errors/domain.exception';

/** `lastUsedAt` is only rewritten this often; every request would be a write. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export interface ResolvedApiToken {
  readonly id: string;
  readonly name: string;
}

/**
 * Personal Bearer tokens for the CLI. Same design as sessions: the token is
 * random, stored hashed, and shown once. The stored `prefix` is what the UI
 * displays so an operator can tell two tokens apart without seeing either.
 */
@Injectable()
export class ApiTokenService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    private readonly crypto: CryptoService,
  ) {}

  list(): readonly ApiToken[] {
    const rows = this.db.select().from(apiTokens).all();
    return rows
      .map((row): ApiToken => ({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        expiresAt: row.expiresAt,
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  create(request: CreateApiTokenRequest): CreateApiTokenResponse {
    const existing = this.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(eq(apiTokens.name, request.name))
      .limit(1)
      .all();
    if (existing.length > 0) {
      throw new ConflictError(`A token named "${request.name}" already exists.`);
    }

    const generated = this.crypto.generateApiToken();
    const now = new Date();
    const expiresAt =
      request.expiresInDays === null
        ? null
        : new Date(now.getTime() + request.expiresInDays * 86_400_000).toISOString();

    const item: ApiToken = {
      id: this.crypto.newId(),
      name: request.name,
      prefix: generated.prefix,
      createdAt: now.toISOString(),
      lastUsedAt: null,
      expiresAt,
    };

    this.db
      .insert(apiTokens)
      .values({ ...item, tokenHash: generated.hash })
      .run();

    return { token: generated.token, item };
  }

  revoke(id: string): boolean {
    const result = this.db.delete(apiTokens).where(eq(apiTokens.id, id)).run();
    return result.changes > 0;
  }

  /** `null` for unknown or expired. An expired token is left in place so the UI can show it. */
  resolve(token: string): ResolvedApiToken | null {
    const hash = this.crypto.hashToken(token);
    const [row] = this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hash))
      .limit(1)
      .all();
    if (row === undefined) return null;

    const now = Date.now();
    if (row.expiresAt !== null && Date.parse(row.expiresAt) <= now) return null;

    const lastUsed = row.lastUsedAt === null ? 0 : Date.parse(row.lastUsedAt);
    if (now - lastUsed > LAST_USED_WRITE_INTERVAL_MS) {
      this.db
        .update(apiTokens)
        .set({ lastUsedAt: new Date(now).toISOString() })
        .where(eq(apiTokens.id, row.id))
        .run();
    }

    return { id: row.id, name: row.name };
  }
}
