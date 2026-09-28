import { Injectable } from '@nestjs/common';
import {
  IAM_USER_CSV_COLUMNS,
  type IamUserBulkRequest,
  type IamUserBulkResponse,
  type IamUserBulkResult,
  type CreateS3UserRequest,
  type CreateS3UserResponse,
  type ListIamUsersQuery,
  type S3User,
  type S3UserDetail,
  type S3UserList,
  type S3UserStatus,
  type SetUserGroupsRequest,
  type SetUserPoliciesRequest,
  type UpdateS3UserRequest,
} from '@storage-io/contracts';
import { CSV_BOM, csvRow } from '../../common/csv';
import { bulkMessageOf } from '../../common/errors/bulk-message';
import {
  ConflictError,
  NotFoundError,
  NotSupportedError,
} from '../../common/errors/domain.exception';
import { IamEntityRepository, requireId } from '../iam-core/iam-entity.repository';
import { matchesQuery, paginate } from '../iam-core/iam-page';
import { IamStatsService } from '../iam-core/iam-stats.service';
import { IamTargetService, type IamTarget } from '../iam-core/iam-target.service';
import { AccessKeysService } from '../access-keys/access-keys.service';
import type { RawIamUserDetail } from '../../providers/iam/iam-driver';

/**
 * The business layer for S3 users.
 *
 * The one mapping worth knowing about is **status**. MinIO and Ceph RGW have a real
 * enabled/disabled user, so `PATCH …/users/:name` sets it. AWS IAM and SeaweedFS do
 * not: an IAM user is always "there" and what can be turned off is its access keys.
 * Rather than invent a status field, the driver reports `unknown` and this service
 * derives one from the user's keys — a user whose keys are all disabled reads as
 * `disabled`, which is what an operator means by the word. A status change on such a
 * provider therefore acts on the keys, and says so.
 */
@Injectable()
export class IamUsersService {
  constructor(
    private readonly targets: IamTargetService,
    private readonly accessKeys: AccessKeysService,
    private readonly stats: IamStatsService,
    private readonly entities: IamEntityRepository,
  ) {}

  /* ------------------------------ reading ------------------------- */

  async list(query: ListIamUsersQuery): Promise<S3UserList> {
    const aggregated = await this.targets.aggregate('iamUsers', query.serverId, async (target) =>
      this.usersOf(target),
    );

    const filtered = aggregated.items.filter(
      (user) =>
        (query.status === undefined || user.status === query.status) &&
        matchesQuery(query.q, user.name, ...user.policies, ...user.groups),
    );
    const sorted = [...filtered].sort(
      (left, right) =>
        left.serverName.localeCompare(right.serverName) || left.name.localeCompare(right.name),
    );

    const page = paginate(sorted, query.page, query.pageSize);
    return { items: [...page.items], total: page.total, unavailable: [...aggregated.unavailable] };
  }

  async exportCsv(query: ListIamUsersQuery): Promise<string> {
    const full = await this.list({ ...query, page: 1, pageSize: CSV_MAX_ROWS });

    let csv = CSV_BOM + csvRow(IAM_USER_CSV_COLUMNS);
    for (const user of full.items) {
      csv += csvRow([
        user.serverName,
        user.provider,
        user.name,
        user.status,
        user.policies.join(' '),
        user.groups.join(' '),
        user.accessKeyCount,
        user.createdAt,
        user.lastActivityAt,
      ]);
    }
    return csv;
  }

  async findOne(serverIdOrName: string, name: string): Promise<S3UserDetail> {
    const target = this.targets.targetFor(serverIdOrName, 'iamUsers');
    return this.detailOf(target, name);
  }

  /**
   * `GET /iam/users/:userId` — the resolve endpoint the web app navigates by. The
   * id names a server and a user name; the detail is then read from that server
   * exactly as the name-based route does.
   */
  async findById(userId: string): Promise<S3UserDetail> {
    const ref = this.entities.find(userId);
    if (ref === null || ref.kind !== 'user') throw new NotFoundError('No such user.');
    return this.findOne(ref.serverId, ref.name);
  }

  /* ------------------------------ writing ------------------------- */

  async create(
    serverIdOrName: string,
    request: CreateS3UserRequest,
  ): Promise<CreateS3UserResponse> {
    const target = this.targets.targetFor(serverIdOrName, 'iamUsers');
    const users = this.targets.providers.iamUsersFor(target.connection);

    const existing = await users.get(target.connection, request.name);
    if (existing !== null) {
      throw new ConflictError(
        `A user named "${request.name}" already exists on ${target.row.name}.`,
      );
    }

    await users.create(target.connection, { name: request.name, secret: request.secret });

    // Policies and groups are applied after creation, because that is the only
    // order every driver supports — and a provider that supports neither must say
    // so rather than silently dropping what the operator asked for.
    if (request.policies.length > 0) {
      await this.applyPolicies(target, request.name, request.policies);
    }
    if (request.groups.length > 0) {
      await this.applyGroups(target, request.name, request.groups);
    }

    // `Server.counts.users` is part of the server list, so it is brought up to date
    // with the mutation rather than at the next sweep.
    await this.stats.refreshServer(target.row.id);

    const user = await this.userOf(target, request.name);
    if (!request.createAccessKey) return { user, accessKey: null };

    const accessKey = await this.accessKeys.create(target.row.id, {
      userName: request.name,
      name: `${request.name} initial key`,
      expiresAt: null,
      policy: null,
    });
    return { user: { ...user, accessKeyCount: user.accessKeyCount + 1 }, accessKey };
  }

  async setStatus(
    serverIdOrName: string,
    name: string,
    request: UpdateS3UserRequest,
  ): Promise<S3UserDetail> {
    const target = this.targets.targetFor(serverIdOrName, 'iamUsers');
    const users = this.targets.providers.iamUsersFor(target.connection);
    await this.requireUser(target, name);

    if (users.setStatus !== undefined) {
      await users.setStatus(target.connection, name, request.status);
      return this.detailOf(target, name);
    }

    // No user status on this provider: act on the keys, which is what disabling a
    // user means here. A provider that cannot do that either says so.
    const keys = this.targets.providers.iamKeysFor(target.connection);
    if (keys.update === undefined || !this.targets.canDeactivateKeys(target)) {
      throw new NotSupportedError(
        `${target.row.provider} has neither a user status nor a way to disable a key, so this user cannot be disabled.`,
      );
    }

    const owned = await keys.list(target.connection, name);
    for (const key of owned) {
      await keys.update(target.connection, key.accessKeyId, name, {
        enabled: request.status === 'enabled',
      });
    }
    return this.detailOf(target, name);
  }

  async setPolicies(
    serverIdOrName: string,
    name: string,
    request: SetUserPoliciesRequest,
  ): Promise<S3UserDetail> {
    const target = this.targets.targetFor(serverIdOrName, 'iamPolicies');
    await this.requireUser(target, name);
    await this.applyPolicies(target, name, request.policies);
    return this.detailOf(target, name);
  }

  async setGroups(
    serverIdOrName: string,
    name: string,
    request: SetUserGroupsRequest,
  ): Promise<S3UserDetail> {
    const target = this.targets.targetFor(serverIdOrName, 'iamGroups');
    await this.requireUser(target, name);
    await this.applyGroups(target, name, request.groups);
    return this.detailOf(target, name);
  }

  async delete(serverIdOrName: string, name: string): Promise<void> {
    const target = this.targets.targetFor(serverIdOrName, 'iamUsers');
    const users = this.targets.providers.iamUsersFor(target.connection);
    await this.requireUser(target, name);

    // The user's keys go first: IAM refuses to delete a user that still has any,
    // and MinIO deletes them silently — so doing it here makes the two behave the
    // same and leaves no `key_meta` row pointing at a key that no longer exists.
    await this.accessKeys.deleteKeysOfUser(target, name);
    await users.delete(target.connection, name);
    await this.stats.refreshServer(target.row.id);
  }

  /* -------------------------------- bulk -------------------------- */

  /**
   * One action over many users. Every row is attempted and reported on its own:
   * a set where the third user is on an offline server must still apply to the
   * other nine, which is what makes this different from a loop that throws.
   *
   * Sequential rather than parallel, like the bucket bulk: each row is one or two
   * calls to a storage server's admin API, and a hundred at once is how the
   * console becomes the reason that server is slow.
   */
  async bulk(request: IamUserBulkRequest): Promise<IamUserBulkResponse> {
    const targets = this.resolveBulkTargets(request);
    const results: IamUserBulkResult[] = [];

    for (const target of targets) {
      if (target.serverId === null || target.name === null) {
        results.push({ ...target, ok: false, message: 'NOT_FOUND: no such user.' });
        continue;
      }

      try {
        await this.applyBulkAction(request, target.serverId, target.name);
        results.push({ ...target, ok: true, message: null });
      } catch (error) {
        results.push({ ...target, ok: false, message: bulkMessageOf(error) });
      }
    }

    return { results };
  }

  /**
   * The request's targets, however they were addressed. `ids` are resolved in one
   * query; an id this installation never issued becomes a row with no server and
   * a `NOT_FOUND` message rather than failing the whole request.
   */
  private resolveBulkTargets(
    request: IamUserBulkRequest,
  ): readonly { id: string | null; serverId: string | null; name: string | null }[] {
    const ids = request.ids ?? [];
    const refs = request.users ?? [];

    const resolved = this.entities.findMany(ids);
    const byId = ids.map((id) => {
      const entity = resolved.get(id);
      if (entity === undefined || entity.kind !== 'user') {
        return { id, serverId: null, name: null };
      }
      return { id, serverId: entity.serverId, name: entity.name };
    });

    const byRef = refs.map((ref) => ({
      id: null,
      serverId: ref.serverId,
      name: ref.name,
    }));

    return [...byId, ...byRef];
  }

  private async applyBulkAction(
    request: IamUserBulkRequest,
    serverId: string,
    name: string,
  ): Promise<void> {
    switch (request.action) {
      case 'enable':
        await this.setStatus(serverId, name, { status: 'enabled' });
        return;
      case 'disable':
        await this.setStatus(serverId, name, { status: 'disabled' });
        return;
      case 'delete':
        await this.delete(serverId, name);
        return;
      case 'attach-policy': {
        const next = await this.policiesWith(serverId, name, request.payload.policy, true);
        await this.setPolicies(serverId, name, { policies: next });
        return;
      }
      case 'detach-policy': {
        const next = await this.policiesWith(serverId, name, request.payload.policy, false);
        await this.setPolicies(serverId, name, { policies: next });
        return;
      }
    }
  }

  /**
   * The user's policy set with one name added or removed. `PUT …/policies` takes
   * a full set, so attaching one means reading the current set first — and reading
   * it per row is unavoidable: two rows may be different users on different
   * servers.
   */
  private async policiesWith(
    serverId: string,
    name: string,
    policy: string,
    attach: boolean,
  ): Promise<string[]> {
    const target = this.targets.targetFor(serverId, 'iamPolicies');
    const user = await this.requireUser(target, name);
    const current = user.policies.filter((existing) => existing !== policy);
    if (!attach) return current;
    return [...current, policy];
  }

  /* ------------------------------ mapping ------------------------- */

  /** One server's users, with each one's key count. */
  private async usersOf(target: IamTarget): Promise<readonly S3User[]> {
    const users = this.targets.providers.iamUsersFor(target.connection);
    const raw = await users.list(target.connection);

    const keyCounts = await this.keyCountsOf(target);
    const stamp = this.targets.stamp(target.row);
    const names = raw.map((user) => user.name);
    const ids = this.entities.idsFor(target.row.id, 'user', names);

    return raw.map((user) => ({
      id: requireId(ids, user.name),
      ...stamp,
      name: user.name,
      status: statusOf(user, keyCounts.get(user.name)),
      policies: [...user.policies],
      groups: [...user.memberOf],
      accessKeyCount: keyCounts.get(user.name)?.total ?? 0,
      createdAt: user.createdAt,
      // No provider in scope reports a user's last activity; IAM reports it per
      // key, so the newest key use is the closest honest answer.
      lastActivityAt: keyCounts.get(user.name)?.lastUsedAt ?? null,
    }));
  }

  private async userOf(target: IamTarget, name: string): Promise<S3User> {
    const raw = await this.requireUser(target, name);
    const counts = await this.keyCountsOf(target, name);
    const stamp = this.targets.stamp(target.row);
    const id = this.entities.idFor(target.row.id, 'user', raw.name);

    return {
      id,
      ...stamp,
      name: raw.name,
      status: statusOf(raw, counts.get(name)),
      policies: [...raw.policies],
      groups: [...raw.memberOf],
      accessKeyCount: counts.get(name)?.total ?? 0,
      createdAt: raw.createdAt,
      lastActivityAt: counts.get(name)?.lastUsedAt ?? null,
    };
  }

  private async detailOf(target: IamTarget, name: string): Promise<S3UserDetail> {
    const user = await this.userOf(target, name);
    const keys = await this.accessKeys.keysOf(target, name);
    const inherited = await this.inheritedPoliciesOf(target, user.groups);

    return { ...user, accessKeys: [...keys], inheritedPolicies: inherited };
  }

  /**
   * The policies a user gets through its groups, named with the group they come
   * from — so the detail page can show why a permission is there.
   */
  private async inheritedPoliciesOf(
    target: IamTarget,
    groupNames: readonly string[],
  ): Promise<{ policy: string; fromGroup: string }[]> {
    if (groupNames.length === 0) return [];

    const groups = this.targets.providers.iamGroupsIfAny(target.connection);
    // A provider without groups has nothing to inherit from, and the user's own
    // group list would have been empty anyway.
    if (groups === null) return [];

    const described = await Promise.all(
      groupNames.map(async (name) => groups.get(target.connection, name)),
    );

    const inherited: { policy: string; fromGroup: string }[] = [];
    for (const group of described) {
      if (group === null) continue;
      for (const policy of group.policies) inherited.push({ policy, fromGroup: group.name });
    }
    return inherited;
  }

  /**
   * Key counts per user in one pass. A provider without access keys contributes
   * nothing rather than failing the user list — the count is a decoration, not the
   * point of the screen.
   */
  private async keyCountsOf(
    target: IamTarget,
    userName?: string,
  ): Promise<ReadonlyMap<string, { total: number; enabled: number; lastUsedAt: string | null }>> {
    const counts = new Map<string, { total: number; enabled: number; lastUsedAt: string | null }>();
    try {
      const keys = await this.accessKeys.keysOf(target, userName);
      for (const key of keys) {
        const entry = counts.get(key.userName) ?? { total: 0, enabled: 0, lastUsedAt: null };
        entry.total += 1;
        if (key.status === 'active') entry.enabled += 1;
        if (
          key.lastUsedAt !== null &&
          (entry.lastUsedAt === null || key.lastUsedAt > entry.lastUsedAt)
        ) {
          entry.lastUsedAt = key.lastUsedAt;
        }
        counts.set(key.userName, entry);
      }
    } catch {
      // No access-key surface on this provider, or it is unreachable. Either way
      // the users are still worth listing.
    }
    return counts;
  }

  private async requireUser(target: IamTarget, name: string): Promise<RawIamUserDetail> {
    const users = this.targets.providers.iamUsersFor(target.connection);
    const user = await users.get(target.connection, name);
    if (user === null) throw new NotFoundError(`No user "${name}" on ${target.row.name}.`);
    return user;
  }

  /** Replaces the user's whole attached-policy set, or says the provider cannot. */
  private async applyPolicies(
    target: IamTarget,
    name: string,
    policies: readonly string[],
  ): Promise<void> {
    const users = this.targets.providers.iamUsersFor(target.connection);
    if (users.setPolicies === undefined) {
      throw new NotSupportedError(
        `${target.row.provider} has no named policies to attach to a user in storage-io.`,
      );
    }
    await users.setPolicies(target.connection, name, policies);
  }

  private async applyGroups(
    target: IamTarget,
    name: string,
    groups: readonly string[],
  ): Promise<void> {
    const users = this.targets.providers.iamUsersFor(target.connection);
    if (users.setGroups === undefined) {
      throw new NotSupportedError(`${target.row.provider} has no user groups in storage-io.`);
    }
    await users.setGroups(target.connection, name, groups);
  }
}

/* ------------------------------ helpers --------------------------- */

const CSV_MAX_ROWS = 5_000;

/**
 * A provider that has no user status leaves it `unknown`; a user whose keys exist
 * and are all disabled is what an operator calls disabled, so that is reported.
 * With no keys at all there is nothing to infer from and `unknown` stands.
 */
function statusOf(
  user: RawIamUserDetail,
  keys: { total: number; enabled: number } | undefined,
): S3UserStatus {
  if (user.status !== 'unknown') return user.status;
  if (keys === undefined || keys.total === 0) return 'unknown';
  return keys.enabled > 0 ? 'enabled' : 'disabled';
}
