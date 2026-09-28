import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, like, lt, lte, or, type SQL } from 'drizzle-orm';
import {
  type ActivityCategory,
  type ActivityEvent,
  type ActivityList,
  type ActivityResult,
  type ActorType,
  type ListActivityQuery,
  type PaginationQuery,
} from '@storage-io/contracts';
import { DB } from '../db/db.module';
import type { AppDatabase } from '../db/migrate';
import { activity } from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';

/** Keys whose values never reach the log, whatever nesting they sit at. */
const REDACTED_KEYS = new Set([
  'password',
  'secret',
  'secretaccesskey',
  'admintoken',
  'bottoken',
  'token',
  'passphrase',
  'authorization',
  'cookie',
  'capem',
]);
const REDACTED = '[redacted]';
const MAX_DETAIL_DEPTH = 6;
const MAX_STRING_LENGTH = 2000;

export interface RecordActivityInput {
  readonly category: ActivityCategory;
  /** Dotted verb, e.g. `server.create`. */
  readonly action: string;
  readonly title: string;
  readonly actor: { readonly type: ActorType; readonly name: string };
  readonly result: ActivityResult;
  readonly target?: string | null;
  readonly serverId?: string | null;
  readonly serverName?: string | null;
  readonly ip?: string | null;
  readonly requestId?: string | null;
  readonly details?: Record<string, unknown>;
}

/**
 * The audit trail. Two ways in: the interceptor, for every mutating request, and
 * this service directly, for system events no request caused (a health
 * transition, a job finishing, a quota crossing its threshold).
 *
 * Whatever the source, `details` is sanitized here rather than at each call site
 * — one place to get right, and a new caller cannot forget.
 */
@Injectable()
export class ActivityService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    private readonly crypto: CryptoService,
  ) {}

  record(input: RecordActivityInput): ActivityEvent {
    const event: ActivityEvent = {
      id: this.crypto.newId(),
      at: new Date().toISOString(),
      category: input.category,
      action: input.action,
      title: input.title,
      actor: { type: input.actor.type, name: input.actor.name },
      target: input.target ?? null,
      serverId: input.serverId ?? null,
      serverName: input.serverName ?? null,
      ip: input.ip ?? null,
      result: input.result,
      requestId: input.requestId ?? null,
      details: sanitizeDetails(input.details ?? {}),
    };

    this.db
      .insert(activity)
      .values({
        id: event.id,
        at: event.at,
        category: event.category,
        action: event.action,
        title: event.title,
        actorType: event.actor.type,
        actorName: event.actor.name,
        target: event.target,
        serverId: event.serverId,
        serverName: event.serverName,
        ip: event.ip,
        result: event.result,
        requestId: event.requestId,
        details: event.details,
      })
      .run();

    return event;
  }

  list(filters: ListActivityQuery, page: PaginationQuery): ActivityList {
    const where = this.buildWhere(filters);

    const [totals] = this.db.select({ total: count() }).from(activity).where(where).all();
    const rows = this.db
      .select()
      .from(activity)
      .where(where)
      .orderBy(desc(activity.at), desc(activity.id))
      .limit(page.pageSize)
      .offset((page.page - 1) * page.pageSize)
      .all();

    return { items: rows.map(toActivityEvent), total: totals?.total ?? 0 };
  }

  findById(id: string): ActivityEvent | null {
    const [row] = this.db.select().from(activity).where(eq(activity.id, id)).limit(1).all();
    return row === undefined ? null : toActivityEvent(row);
  }

  /**
   * Streamed in pages rather than loaded whole: an export of a year of activity
   * must not depend on the whole table fitting in memory.
   */
  *iterateForExport(filters: ListActivityQuery, batchSize = 500): Generator<ActivityEvent> {
    const where = this.buildWhere(filters);
    let offset = 0;

    for (;;) {
      const rows = this.db
        .select()
        .from(activity)
        .where(where)
        .orderBy(desc(activity.at), desc(activity.id))
        .limit(batchSize)
        .offset(offset)
        .all();

      if (rows.length === 0) return;
      for (const row of rows) yield toActivityEvent(row);
      if (rows.length < batchSize) return;
      offset += batchSize;
    }
  }

  /** Retention sweep: one set-based delete, never a read-then-loop. */
  deleteOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = this.db.delete(activity).where(lt(activity.at, cutoff)).run();
    return result.changes;
  }

  private buildWhere(filters: ListActivityQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (filters.from !== undefined) conditions.push(gte(activity.at, filters.from));
    if (filters.to !== undefined) conditions.push(lte(activity.at, filters.to));
    if (filters.serverId !== undefined) conditions.push(eq(activity.serverId, filters.serverId));
    if (filters.category !== undefined) conditions.push(eq(activity.category, filters.category));
    if (filters.result !== undefined) conditions.push(eq(activity.result, filters.result));

    if (filters.q !== undefined && filters.q.length > 0) {
      const needle = `%${escapeLike(filters.q)}%`;
      const search = or(
        like(activity.title, needle),
        like(activity.action, needle),
        like(activity.target, needle),
        like(activity.actorName, needle),
      );
      if (search !== undefined) conditions.push(search);
    }

    if (conditions.length === 0) return undefined;
    return and(...conditions);
  }
}

/* ------------------------------ mapping --------------------------- */

type ActivityRow = typeof activity.$inferSelect;

function toActivityEvent(row: ActivityRow): ActivityEvent {
  return {
    id: row.id,
    at: row.at,
    category: row.category as ActivityCategory,
    action: row.action,
    title: row.title,
    actor: { type: row.actorType as ActorType, name: row.actorName },
    target: row.target,
    serverId: row.serverId,
    serverName: row.serverName,
    ip: row.ip,
    result: row.result as ActivityResult,
    requestId: row.requestId,
    details: row.details,
  };
}

/** `%` and `_` are wildcards in LIKE; a search for "a_b" must mean "a_b". */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Drops secrets and bounds size. A `details` blob is written by a dozen call
 * sites and read by an operator months later, so it must never have become the
 * place a credential leaked into.
 */
export function sanitizeDetails(
  value: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth >= MAX_DETAIL_DEPTH) return {};

  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = sanitizeValue(raw, depth);
  }
  return result;
}

function sanitizeValue(raw: unknown, depth: number): unknown {
  if (typeof raw === 'string') {
    return raw.length > MAX_STRING_LENGTH ? `${raw.slice(0, MAX_STRING_LENGTH)}…` : raw;
  }
  if (Array.isArray(raw)) return raw.slice(0, 100).map((entry) => sanitizeValue(entry, depth + 1));
  if (typeof raw === 'object' && raw !== null) {
    return sanitizeDetails(raw as Record<string, unknown>, depth + 1);
  }
  return raw;
}
