import { Injectable, Logger } from '@nestjs/common';
import {
  ACCESS_KEY_CSV_COLUMNS,
  type AccessKey,
  type AccessKeyList,
  type CreateAccessKeyRequest,
  type CreatedKey,
  type ListAccessKeysQuery,
  type RotateAccessKeyRequest,
  type UpdateAccessKeyRequest,
} from '@storage-io/contracts';
import { CSV_BOM, csvRow } from '../../common/csv';
import {
  ConflictError,
  NotFoundError,
  NotSupportedError,
  ValidationError,
} from '../../common/errors/domain.exception';
import { countKeys, isExpiringSoon, toAccessKey } from '../iam-core/access-key.mapper';
import { matchesQuery, paginate } from '../iam-core/iam-page';
import { IamTargetService, type IamTarget } from '../iam-core/iam-target.service';
import { KeyMetaRepository } from '../iam-core/key-meta.repository';
import type { RawAccessKey } from '../../providers/iam/iam-driver';

/**
 * The business layer for access keys: `/iam/access-keys` and everything under
 * `/servers/:sid/iam/access-keys`.
 *
 * Three things here are more than a pass-through to a driver:
 *
 * - **The secret is returned exactly once**, in the response to the create (or
 *   rotate) that produced it. Nothing stores it, and no later read can recover it —
 *   which is why `key_meta` holds a name and an expiry and never a credential.
 * - **Rotation is a create plus a scheduled disable**, not a replace. The caller
 *   gets the new key immediately and the old one keeps working for `graceSeconds`,
 *   so a deployment mid-rotation does not lose access. The grace period lives in
 *   `key_meta`, so a restart does not lose it either.
 * - **Expiry is merged, not assumed.** MinIO enforces its own; everywhere else the
 *   date is app-tracked and `KeyExpiryService` acts on it. `access-key.mapper.ts`
 *   holds the merge rules.
 */
@Injectable()
export class AccessKeysService {
  private readonly log = new Logger(AccessKeysService.name);

  constructor(
    private readonly targets: IamTargetService,
    private readonly keyMeta: KeyMetaRepository,
  ) {}

  /* ------------------------------ reading ------------------------- */

  async list(query: ListAccessKeysQuery): Promise<AccessKeyList> {
    const aggregated = await this.targets.aggregate('accessKeys', query.serverId, async (target) =>
      this.keysOf(target, query.userName),
    );

    const filtered = aggregated.items.filter(
      (key) =>
        matchesFilter(key, query.status) &&
        matchesQuery(query.q, key.accessKeyId, key.userName, key.name),
    );
    const sorted = [...filtered].sort(byNewestFirst);

    const page = paginate(sorted, query.page, query.pageSize);
    return {
      items: [...page.items],
      total: page.total,
      // The chips above the table describe the whole set the filters left, which
      // is why they are counted before paging — and before the status filter, so
      // "3 expiring" still shows while "active" is selected.
      counts: countKeys(
        aggregated.items.filter((key) =>
          matchesQuery(query.q, key.accessKeyId, key.userName, key.name),
        ),
      ),
      unavailable: [...aggregated.unavailable],
    };
  }

  async exportCsv(query: ListAccessKeysQuery): Promise<string> {
    // The export is the filtered set, not the page: a CSV of 50 rows out of 300
    // is the kind of quiet truncation that gets acted on.
    const full = await this.list({ ...query, page: 1, pageSize: CSV_MAX_ROWS });

    let csv = CSV_BOM + csvRow(ACCESS_KEY_CSV_COLUMNS);
    for (const key of full.items) {
      csv += csvRow([
        key.serverName,
        key.provider,
        key.accessKeyId,
        key.userName,
        key.name,
        key.status,
        key.restricted,
        key.createdAt,
        key.expiresAt,
        key.lastUsedAt,
      ]);
    }
    return csv;
  }

  /** One server's keys, merged with what storage-io tracks. */
  async keysOf(target: IamTarget, userName?: string): Promise<readonly AccessKey[]> {
    const keys = this.targets.providers.iamKeysFor(target.connection);
    const raw = await keys.list(target.connection, userName);

    const meta = this.keyMeta.byServer(target.row.id);
    const stamp = this.targets.stamp(target.row);
    const now = new Date();

    if (userName === undefined) {
      // A complete listing is the only safe moment to drop rows for keys the
      // provider no longer has — from a filtered one it would delete every other
      // user's metadata.
      const present = raw.map((key) => key.accessKeyId);
      const pruned = this.keyMeta.pruneMissing(target.row.id, present);
      if (pruned > 0) {
        this.log.log({ server: target.row.name, pruned }, 'Dropped key metadata for removed keys');
      }
    }

    return raw.map((key) => toAccessKey(stamp, key, meta.get(key.accessKeyId), now));
  }

  /* ------------------------------ writing ------------------------- */

  async create(serverIdOrName: string, request: CreateAccessKeyRequest): Promise<CreatedKey> {
    const target = this.targets.targetFor(serverIdOrName, 'accessKeys');
    const keys = this.targets.providers.iamKeysFor(target.connection);

    if (request.policy !== null && !keys.supportsSessionPolicy) {
      throw new NotSupportedError(
        `${target.row.provider} cannot narrow a key with its own policy; create the key without one.`,
      );
    }
    if (request.expiresAt !== null) {
      assertFuture(request.expiresAt);
    }

    const created = await keys.create(target.connection, {
      userName: request.userName,
      name: request.name,
      description: null,
      // A provider without a native expiry is handed none; the date is stored
      // below and the scheduler enforces it.
      expiresAt: keys.supportsNativeExpiry ? request.expiresAt : null,
      policy: request.policy,
    });

    const expiresAt = created.expiresAt ?? request.expiresAt;
    this.keyMeta.upsert(target.row.id, created.accessKeyId, {
      userName: request.userName,
      name: request.name,
      createdAt: new Date().toISOString(),
      expiresAt,
      status: 'active',
      restricted: request.policy !== null,
      expiryNotifiedAt: null,
    });

    return this.createdKeyOf(
      target,
      created.accessKeyId,
      created.secretAccessKey,
      request.userName,
    );
  }

  async update(
    serverIdOrName: string,
    accessKeyId: string,
    request: UpdateAccessKeyRequest,
  ): Promise<AccessKey> {
    const target = this.targets.targetFor(serverIdOrName, 'accessKeys');
    const keys = this.targets.providers.iamKeysFor(target.connection);

    const existing = await this.requireKey(target, accessKeyId);

    if (
      request.status !== undefined &&
      (keys.update === undefined || !this.targets.canDeactivateKeys(target))
    ) {
      throw new NotSupportedError(
        `${target.row.provider} cannot enable or disable a key; delete it instead.`,
      );
    }
    if (request.expiresAt !== undefined && request.expiresAt !== null) {
      assertFuture(request.expiresAt);
    }

    const patch: { name?: string; enabled?: boolean; expiresAt?: string | null } = {};
    if (request.name !== undefined && keys.supportsKeyName) patch.name = request.name;
    if (request.status !== undefined) patch.enabled = request.status === 'active';
    if (request.expiresAt !== undefined && keys.supportsNativeExpiry) {
      patch.expiresAt = request.expiresAt;
    }

    if (Object.keys(patch).length > 0 && keys.update !== undefined) {
      await keys.update(target.connection, accessKeyId, existing.userName, patch);
    }

    this.keyMeta.upsert(target.row.id, accessKeyId, {
      userName: existing.userName,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.status === undefined
        ? {}
        : { status: request.status === 'active' ? ('active' as const) : ('disabled' as const) }),
      // A new expiry is a new deadline, so the "expires soon" notice may fire again.
      ...(request.expiresAt === undefined
        ? {}
        : { expiresAt: request.expiresAt, expiryNotifiedAt: null }),
    });

    return this.requireKey(target, accessKeyId);
  }

  async delete(serverIdOrName: string, accessKeyId: string): Promise<void> {
    const target = this.targets.targetFor(serverIdOrName, 'accessKeys');
    const keys = this.targets.providers.iamKeysFor(target.connection);

    const existing = await this.requireKey(target, accessKeyId);
    await keys.delete(target.connection, accessKeyId, existing.userName);
    this.keyMeta.delete(target.row.id, accessKeyId);
  }

  /**
   * Creates a replacement and schedules the old key's deactivation.
   *
   * `graceSeconds: 0` disables the old key before returning, so "rotate now" is
   * really now. Anything larger is recorded in `key_meta` and finished by
   * `KeyExpiryService`, so a restart during the grace period does not leave the old
   * key alive forever.
   */
  async rotate(
    serverIdOrName: string,
    accessKeyId: string,
    request: RotateAccessKeyRequest,
  ): Promise<CreatedKey> {
    const target = this.targets.targetFor(serverIdOrName, 'accessKeys');
    const keys = this.targets.providers.iamKeysFor(target.connection);

    const existing = await this.requireKey(target, accessKeyId);
    if (keys.update === undefined || !this.targets.canDeactivateKeys(target)) {
      throw new NotSupportedError(
        `${target.row.provider} cannot deactivate a key, so it cannot be rotated safely; create a new key and delete this one when nothing uses it.`,
      );
    }
    if (existing.rotation !== null) {
      throw new ConflictError(
        `This key is already being rotated; it is replaced by "${existing.rotation.replacedBy}".`,
      );
    }
    if (request.expiresAt !== null) assertFuture(request.expiresAt);

    const replacementName = rotatedName(existing.name ?? accessKeyId);
    const created = await keys.create(target.connection, {
      userName: existing.userName,
      name: replacementName,
      description: `Replaces ${accessKeyId}`,
      expiresAt: keys.supportsNativeExpiry ? request.expiresAt : null,
      policy: null,
    });

    const now = new Date();
    this.keyMeta.upsert(target.row.id, created.accessKeyId, {
      userName: existing.userName,
      name: replacementName,
      createdAt: now.toISOString(),
      expiresAt: created.expiresAt ?? request.expiresAt,
      status: 'active',
      restricted: false,
      expiryNotifiedAt: null,
    });

    if (request.graceSeconds === 0) {
      await keys.update(target.connection, accessKeyId, existing.userName, { enabled: false });
      this.keyMeta.upsert(target.row.id, accessKeyId, {
        userName: existing.userName,
        status: 'disabled',
        rotationReplacedBy: created.accessKeyId,
        rotationDisableAt: null,
      });
    } else {
      const disableAt = new Date(now.getTime() + request.graceSeconds * 1000).toISOString();
      this.keyMeta.upsert(target.row.id, accessKeyId, {
        userName: existing.userName,
        rotationReplacedBy: created.accessKeyId,
        rotationDisableAt: disableAt,
      });
    }

    return this.createdKeyOf(
      target,
      created.accessKeyId,
      created.secretAccessKey,
      existing.userName,
    );
  }

  /** Every key of one user, for the user-delete path. */
  async deleteKeysOfUser(target: IamTarget, userName: string): Promise<void> {
    const keys = this.targets.providers.iamKeysFor(target.connection);
    const existing = await keys.list(target.connection, userName);
    for (const key of existing) {
      await keys.delete(target.connection, key.accessKeyId, userName);
    }
    this.keyMeta.deleteByUser(target.row.id, userName);
  }

  /* ------------------------------ helpers ------------------------- */

  private async requireKey(target: IamTarget, accessKeyId: string): Promise<AccessKey> {
    const keys = this.targets.providers.iamKeysFor(target.connection);
    const raw = await keys.get(target.connection, accessKeyId);
    if (raw === null) {
      throw new NotFoundError(`No access key "${accessKeyId}" on ${target.row.name}.`);
    }
    const meta = this.keyMeta.find(target.row.id, accessKeyId) ?? undefined;
    return toAccessKey(this.targets.stamp(target.row), raw, meta);
  }

  private async createdKeyOf(
    target: IamTarget,
    accessKeyId: string,
    secretAccessKey: string,
    userName: string,
  ): Promise<CreatedKey> {
    const accessKey = await this.keyOrPlaceholder(target, accessKeyId, userName);
    return {
      accessKey,
      secretAccessKey,
      endpoint: target.row.endpoint,
      region: target.row.region,
    };
  }

  /**
   * Reads the key back so the response describes what the server really stored.
   * A provider that has not made it visible yet must not cost the caller the
   * secret it just received, so the fallback is what storage-io asked for.
   */
  private async keyOrPlaceholder(
    target: IamTarget,
    accessKeyId: string,
    userName: string,
  ): Promise<AccessKey> {
    try {
      return await this.requireKey(target, accessKeyId);
    } catch {
      const meta = this.keyMeta.find(target.row.id, accessKeyId) ?? undefined;
      const raw: RawAccessKey = {
        accessKeyId,
        userName,
        name: meta?.name ?? null,
        enabled: true,
        restricted: meta?.restricted === true,
        createdAt: meta?.createdAt ?? null,
        expiresAt: meta?.expiresAt ?? null,
        lastUsedAt: null,
      };
      return toAccessKey(this.targets.stamp(target.row), raw, meta);
    }
  }
}

/* ------------------------------ helpers --------------------------- */

/** A bound on the export, so one request cannot ask for an unbounded read. */
const CSV_MAX_ROWS = 5_000;

function matchesFilter(key: AccessKey, filter: ListAccessKeysQuery['status']): boolean {
  switch (filter) {
    case undefined:
      return true;
    case 'active':
      return key.status === 'active';
    case 'disabled':
      return key.status === 'disabled';
    case 'expired':
      return key.status === 'expired';
    case 'expiring':
      return isExpiringSoon(key);
  }
}

/** Newest first, with keys of unknown age last — the order the keys screen shows. */
function byNewestFirst(left: AccessKey, right: AccessKey): number {
  if (left.createdAt === right.createdAt) return left.accessKeyId.localeCompare(right.accessKeyId);
  if (left.createdAt === null) return 1;
  if (right.createdAt === null) return -1;
  return right.createdAt.localeCompare(left.createdAt);
}

const ROTATED_SUFFIX = ' (rotated)';
const MAX_KEY_NAME_LENGTH = 200;

/** Keeps the replacement recognisable without exceeding the contract's limit. */
function rotatedName(previous: string): string {
  const room = MAX_KEY_NAME_LENGTH - ROTATED_SUFFIX.length;
  const base = previous.endsWith(ROTATED_SUFFIX)
    ? previous.slice(0, -ROTATED_SUFFIX.length)
    : previous;
  return `${base.slice(0, room)}${ROTATED_SUFFIX}`;
}

function assertFuture(expiresAt: string): void {
  if (Date.parse(expiresAt) > Date.now()) return;
  throw new ValidationError('An expiry date must be in the future.', [
    { path: 'expiresAt', message: 'must be in the future' },
  ]);
}
