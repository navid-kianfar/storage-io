import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DB } from '../../db/db.module';
import type { AppDatabase } from '../../db/migrate';
import { iamEntities, type IamEntityRow } from '../../db/schema';
import { CryptoService } from '../../crypto/crypto.service';

/**
 * `iam_entities`: the opaque id of an S3 user, group, policy or access key.
 *
 * None of these lives in a table of ours — the drivers read them live from each
 * storage server — and none of their names is safe in a URL or unique across
 * servers. So this is a **registry, not a mirror**: one row per
 * `(serverId, kind, name)`, holding an id and nothing else about the entity.
 *
 * Two properties are what make the id worth putting in a URL, and both come from
 * the insert being `ON CONFLICT DO UPDATE` over `last_seen_at` only:
 *
 * - **It is assigned once.** A second sighting of the same name updates the
 *   timestamp and leaves the id alone, so repeated lists — and a restart — return
 *   the same id.
 * - **It outlives the entity.** A deleted user's row stays, so recreating the
 *   user under the same name resolves to the same id. Deleting the *server*
 *   cascades the rows away, and an entity created afterwards gets a new id.
 */

export const IAM_ENTITY_KINDS = ['user', 'group', 'policy', 'key'] as const;
export type IamEntityKind = (typeof IAM_ENTITY_KINDS)[number];

/** What a resolved id names. */
export interface IamEntityRef {
  readonly id: string;
  readonly serverId: string;
  readonly kind: IamEntityKind;
  readonly name: string;
}

/**
 * Names per statement. SQLite binds one parameter per value and the insert writes
 * five columns per row, so a page of a driver's listing is comfortably one
 * statement and an unusually large one becomes a handful.
 */
const CHUNK_SIZE = 200;

@Injectable()
export class IamEntityRepository {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * The ids of many entities of one kind on one server, assigning one to any name
   * that has not been seen before. The returned map has an entry for every name
   * given.
   *
   * One insert and one select per chunk — never a query per name, which is the
   * N+1 a list of five hundred users would otherwise become.
   */
  idsFor(
    serverId: string,
    kind: IamEntityKind,
    names: readonly string[],
  ): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    const wanted = [...new Set(names)];
    if (wanted.length === 0) return result;

    const at = new Date().toISOString();

    for (let offset = 0; offset < wanted.length; offset += CHUNK_SIZE) {
      const chunk = wanted.slice(offset, offset + CHUNK_SIZE);
      const values = chunk.map((name) => ({
        id: this.crypto.newId(),
        serverId,
        kind,
        name,
        firstSeenAt: at,
        lastSeenAt: at,
      }));

      this.db
        .insert(iamEntities)
        .values(values)
        // `id` is deliberately absent from the set: a row that already exists
        // keeps the id every link to it was built from.
        .onConflictDoUpdate({
          target: [iamEntities.serverId, iamEntities.kind, iamEntities.name],
          set: { lastSeenAt: at },
        })
        .run();

      const rows = this.db
        .select({ id: iamEntities.id, name: iamEntities.name })
        .from(iamEntities)
        .where(
          and(
            eq(iamEntities.serverId, serverId),
            eq(iamEntities.kind, kind),
            inArray(iamEntities.name, chunk),
          ),
        )
        .all();

      for (const row of rows) result.set(row.name, row.id);
    }

    return result;
  }

  /** The id of one entity, assigning one when it has not been seen before. */
  idFor(serverId: string, kind: IamEntityKind, name: string): string {
    const ids = this.idsFor(serverId, kind, [name]);
    return requireId(ids, name);
  }

  /** What an opaque id names, or `null` when this installation never issued it. */
  find(id: string): IamEntityRef | null {
    const [row] = this.db.select().from(iamEntities).where(eq(iamEntities.id, id)).limit(1).all();
    if (row === undefined) return null;
    return toRef(row);
  }

  /**
   * Several ids at once, for a bulk request addressed by id. Ids the registry does
   * not know are simply absent, which is what the caller reports per row.
   */
  findMany(ids: readonly string[]): ReadonlyMap<string, IamEntityRef> {
    const result = new Map<string, IamEntityRef>();
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return result;

    for (let offset = 0; offset < wanted.length; offset += CHUNK_SIZE) {
      const chunk = wanted.slice(offset, offset + CHUNK_SIZE);
      const rows = this.db.select().from(iamEntities).where(inArray(iamEntities.id, chunk)).all();
      for (const row of rows) result.set(row.id, toRef(row));
    }

    return result;
  }
}

/* ------------------------------ helpers --------------------------- */

/**
 * `idsFor` answers for every name it was given, so a miss is a broken invariant
 * rather than a case to handle — and an id silently defaulted to `''` would ship
 * a dead link into the UI.
 */
export function requireId(ids: ReadonlyMap<string, string>, name: string): string {
  const id = ids.get(name);
  if (id === undefined) throw new Error(`No opaque id was assigned for "${name}".`);
  return id;
}

function toRef(row: IamEntityRow): IamEntityRef {
  return { id: row.id, serverId: row.serverId, kind: row.kind as IamEntityKind, name: row.name };
}
