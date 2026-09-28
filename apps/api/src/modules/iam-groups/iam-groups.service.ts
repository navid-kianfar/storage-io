import { Injectable } from '@nestjs/common';
import type {
  ListIamGroupsQuery,
  S3Group,
  S3GroupList,
  UpsertS3GroupRequest,
} from '@storage-io/contracts';
import { ConflictError, NotFoundError } from '../../common/errors/domain.exception';
import { matchesQuery } from '../iam-core/iam-page';
import { IamTargetService, type IamTarget } from '../iam-core/iam-target.service';

/**
 * The business layer for S3 groups. Only MinIO and AWS-shaped IAM have them;
 * SeaweedFS, Ceph RGW and Garage report `iamGroups: not_supported`, so their
 * endpoints answer `NOT_SUPPORTED` through the registry rather than here.
 *
 * `POST` and `PATCH` both go through the driver's `upsert`, which reconciles to
 * exactly the members and policies given. That is deliberate: the contract's body
 * is a full set (`{ name, members, policies }`), not a delta, and a driver that
 * computed a delta from a stale read would drop a member added a second earlier.
 * MinIO in particular has no "create group" call at all — a group exists because it
 * has a member — which is the kind of difference `upsert` exists to absorb.
 */
@Injectable()
export class IamGroupsService {
  constructor(private readonly targets: IamTargetService) {}

  async list(query: ListIamGroupsQuery): Promise<S3GroupList> {
    const aggregated = await this.targets.aggregate('iamGroups', query.serverId, async (target) =>
      this.groupsOf(target),
    );

    const filtered = aggregated.items.filter((group) =>
      matchesQuery(query.q, group.name, ...group.members, ...group.policies),
    );
    const sorted = [...filtered].sort(
      (left, right) =>
        left.serverName.localeCompare(right.serverName) || left.name.localeCompare(right.name),
    );

    return { items: sorted, total: sorted.length, unavailable: [...aggregated.unavailable] };
  }

  async create(serverIdOrName: string, request: UpsertS3GroupRequest): Promise<S3Group> {
    const target = this.targets.targetFor(serverIdOrName, 'iamGroups');
    const groups = this.targets.providers.iamGroupsFor(target.connection);

    const existing = await groups.get(target.connection, request.name);
    if (existing !== null) {
      throw new ConflictError(
        `A group named "${request.name}" already exists on ${target.row.name}.`,
      );
    }

    await groups.upsert(target.connection, request);
    return this.requireGroup(target, request.name);
  }

  /**
   * The name in the path wins over the one in the body: a PATCH cannot rename a
   * group, because neither MinIO nor IAM can rename one and doing it as
   * delete-and-recreate would drop the members mid-way.
   */
  async update(
    serverIdOrName: string,
    name: string,
    request: UpsertS3GroupRequest,
  ): Promise<S3Group> {
    const target = this.targets.targetFor(serverIdOrName, 'iamGroups');
    const groups = this.targets.providers.iamGroupsFor(target.connection);

    await this.requireGroup(target, name);
    await groups.upsert(target.connection, { ...request, name });
    return this.requireGroup(target, name);
  }

  async delete(serverIdOrName: string, name: string): Promise<void> {
    const target = this.targets.targetFor(serverIdOrName, 'iamGroups');
    const groups = this.targets.providers.iamGroupsFor(target.connection);

    await this.requireGroup(target, name);
    await groups.delete(target.connection, name);
  }

  private async groupsOf(target: IamTarget): Promise<readonly S3Group[]> {
    const groups = this.targets.providers.iamGroupsFor(target.connection);
    const raw = await groups.list(target.connection);

    return raw.map((group) => ({
      serverId: target.row.id,
      serverName: target.row.name,
      name: group.name,
      members: [...group.members],
      policies: [...group.policies],
      status: group.status,
    }));
  }

  private async requireGroup(target: IamTarget, name: string): Promise<S3Group> {
    const groups = this.targets.providers.iamGroupsFor(target.connection);
    const group = await groups.get(target.connection, name);
    if (group === null) throw new NotFoundError(`No group "${name}" on ${target.row.name}.`);

    return {
      serverId: target.row.id,
      serverName: target.row.name,
      name: group.name,
      members: [...group.members],
      policies: [...group.policies],
      status: group.status,
    };
  }
}
