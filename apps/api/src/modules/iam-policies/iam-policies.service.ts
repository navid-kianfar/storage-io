import { Injectable } from '@nestjs/common';
import {
  evaluatePolicy,
  validatePolicyDocument,
  type ListIamPoliciesQuery,
  type PolicyDetail,
  type PolicyList,
  type PolicySummary,
  type PolicyVersionList,
  type PutPolicyRequest,
  type SimulatePolicyRequest,
  type SimulatePolicyResponse,
  type ValidatePolicyRequest,
  type ValidatePolicyResponse,
} from '@storage-io/contracts';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.exception';
import type { RawIamPolicyDetail } from '../../providers/iam/iam-driver';
import { IamEntityRepository, requireId } from '../iam-core/iam-entity.repository';
import { matchesQuery } from '../iam-core/iam-page';
import { IamTargetService, type IamTarget } from '../iam-core/iam-target.service';
import { PolicyVersionRepository } from '../iam-core/policy-version.repository';

/**
 * The business layer for IAM policies.
 *
 * Four things happen here that a driver cannot do on its own:
 *
 * - **A built-in policy is read-only.** MinIO ships `readwrite`, `readonly`,
 *   `writeonly`, `diagnostics` and `consoleAdmin` and refuses to change them; this
 *   service refuses first, with a `CONFLICT` and a sentence, rather than passing the
 *   request down to get `XMinioIAMPolicyInUse` back.
 * - **A document is validated before it is written.** A structurally broken policy
 *   rejected by the provider comes back as a provider error with no field path;
 *   rejected here it comes back as a `VALIDATION` with the statement index that is
 *   wrong.
 * - **Every write is snapshotted** into `policy_versions` *before* it happens, so
 *   `versions` and `versions/:vid/restore` work even on MinIO, which keeps no
 *   history. The snapshot is the document being replaced, not the new one — that is
 *   what "restore" needs.
 * - **Description and `updatedAt`** are storage-io's, because MinIO stores neither
 *   for a canned policy. They come from the newest snapshot.
 */
@Injectable()
export class IamPoliciesService {
  constructor(
    private readonly targets: IamTargetService,
    private readonly versions: PolicyVersionRepository,
    private readonly entities: IamEntityRepository,
  ) {}

  /* ------------------------------ reading ------------------------- */

  async list(query: ListIamPoliciesQuery): Promise<PolicyList> {
    const aggregated = await this.targets.aggregate('iamPolicies', query.serverId, async (target) =>
      this.policiesOf(target),
    );

    const filtered = aggregated.items.filter((policy) =>
      matchesQuery(query.q, policy.name, policy.description),
    );
    const sorted = [...filtered].sort(
      (left, right) =>
        left.serverName.localeCompare(right.serverName) || left.name.localeCompare(right.name),
    );

    return { items: sorted, total: sorted.length, unavailable: [...aggregated.unavailable] };
  }

  async findOne(serverIdOrName: string, name: string): Promise<PolicyDetail> {
    const target = this.targets.targetFor(serverIdOrName, 'iamPolicies');
    return this.detailOf(target, name);
  }

  /**
   * `GET /iam/policies/:policyId` — the resolve endpoint the editor navigates by.
   */
  async findById(policyId: string): Promise<PolicyDetail> {
    const ref = this.entities.find(policyId);
    if (ref === null || ref.kind !== 'policy') throw new NotFoundError('No such policy.');
    return this.findOne(ref.serverId, ref.name);
  }

  /* ------------------------------ writing ------------------------- */

  async put(
    serverIdOrName: string,
    name: string,
    request: PutPolicyRequest,
  ): Promise<PolicyDetail> {
    const target = this.targets.targetFor(serverIdOrName, 'iamPolicies');
    const policies = this.targets.providers.iamPoliciesFor(target.connection);

    const validation = validatePolicyDocument(request.document);
    if (!validation.valid) {
      throw new ValidationError('This policy document is not valid.', validation.errors);
    }

    const existing = await policies.get(target.connection, name);
    if (existing !== null && existing.builtIn) {
      throw new ConflictError(`"${name}" is a built-in policy and cannot be changed.`);
    }

    // One snapshot per edit, plus a baseline the first time storage-io touches a
    // policy that already existed — without that baseline the state before the
    // first edit made here would be the one version nobody could get back to.
    const history = this.versions.list(target.row.id, name);
    if (existing !== null && history.length === 0) {
      this.versions.record(
        target.row.id,
        name,
        existing.document,
        existing.description ?? BASELINE_NOTE,
      );
    }

    await policies.put(target.connection, name, request.document, request.description ?? null);

    // Read back and record what the provider actually stored, not what was
    // sent. A provider may normalise a document as it accepts it — MinIO merges
    // statements that differ only by their Sid — and a history of submitted
    // documents then offers, to restore, a version the server never held. Worse,
    // the state the operator is actually on never reaches the history at all, so
    // the promise the restore dialog makes ("the current document is snapshotted
    // first, so this can be undone the same way") is not kept.
    const stored = await policies.get(target.connection, name);
    if (stored === null) {
      throw new NotFoundError(`No policy "${name}" on ${target.row.name} after writing it.`);
    }

    // This snapshot also carries the description and the `updatedAt` the list
    // shows — MinIO stores neither for a canned policy.
    this.versions.record(target.row.id, name, stored.document, request.description ?? null);
    return this.detailFrom(target, stored);
  }

  async delete(serverIdOrName: string, name: string): Promise<void> {
    const target = this.targets.targetFor(serverIdOrName, 'iamPolicies');
    const policies = this.targets.providers.iamPoliciesFor(target.connection);

    const existing = await policies.get(target.connection, name);
    if (existing === null) throw new NotFoundError(`No policy "${name}" on ${target.row.name}.`);
    if (existing.builtIn) {
      throw new ConflictError(`"${name}" is a built-in policy and cannot be deleted.`);
    }

    await policies.delete(target.connection, name);
    this.versions.deleteForPolicy(target.row.id, name);
  }

  /* ---------------------------- versions -------------------------- */

  /**
   * Reads storage-io's own history, so it answers on a provider with no policy API
   * at all — the snapshots belong to this app, and an empty list is the truth.
   */
  listVersions(serverIdOrName: string, name: string): PolicyVersionList {
    const target = this.targets.target(serverIdOrName);
    return { items: [...this.versions.list(target.row.id, name)] };
  }

  async restoreVersion(
    serverIdOrName: string,
    name: string,
    versionId: string,
  ): Promise<PolicyDetail> {
    const target = this.targets.target(serverIdOrName);
    const version = this.versions.find(target.row.id, name, versionId);
    if (version === null) {
      throw new NotFoundError(`No stored version "${versionId}" of policy "${name}".`);
    }

    // A restore is an ordinary write of an older document, so it snapshots the
    // current one too — restoring a restore has to work.
    return this.put(serverIdOrName, name, {
      document: version.document,
      ...(version.note === null ? {} : { description: version.note }),
    });
  }

  /* ------------------------ validate / simulate ------------------- */

  /** Provider-independent: structural checks only, no action namespace. */
  validate(request: ValidatePolicyRequest): ValidatePolicyResponse {
    const validation = validatePolicyDocument(request.document);
    return {
      valid: validation.valid,
      errors: [...validation.errors],
      warnings: [...validation.warnings],
    };
  }

  /**
   * Evaluates one document against one action/resource pair with the shared
   * evaluator, so the API and the web app's live preview can never disagree.
   */
  simulate(request: SimulatePolicyRequest): SimulatePolicyResponse {
    const evaluation = evaluatePolicy(request.document, {
      action: request.action,
      resource: request.resource,
      ...(request.context === undefined ? {} : { context: request.context }),
    });

    return {
      decision: evaluation.decision,
      statementSid: evaluation.statementSid,
      statementIndex: evaluation.statementIndex,
    };
  }

  /* ------------------------------ mapping ------------------------- */

  private async policiesOf(target: IamTarget): Promise<readonly PolicySummary[]> {
    const policies = this.targets.providers.iamPoliciesFor(target.connection);
    const raw = await policies.list(target.connection);
    const stored = this.versions.metadataByServer(target.row.id);

    // `attachedCount` needs the users and groups, which is one call each rather
    // than one per policy. A provider without either contributes an empty set.
    const [users, groups] = await Promise.all([
      this.attachedPoliciesOfUsers(target),
      this.attachedPoliciesOfGroups(target),
    ]);

    const names = raw.map((policy) => policy.name);
    const ids = this.entities.idsFor(target.row.id, 'policy', names);

    return raw.map((policy) => {
      const metadata = stored.get(policy.name);
      return {
        id: requireId(ids, policy.name),
        serverId: target.row.id,
        serverName: target.row.name,
        name: policy.name,
        builtIn: policy.builtIn,
        description: policy.description ?? metadata?.note ?? null,
        attachedCount: (users.get(policy.name) ?? 0) + (groups.get(policy.name) ?? 0),
        updatedAt: policy.updatedAt ?? metadata?.updatedAt ?? null,
      };
    });
  }

  private async detailOf(target: IamTarget, name: string): Promise<PolicyDetail> {
    const policies = this.targets.providers.iamPoliciesFor(target.connection);
    const policy = await policies.get(target.connection, name);
    if (policy === null) throw new NotFoundError(`No policy "${name}" on ${target.row.name}.`);

    return this.detailFrom(target, policy);
  }

  /** The detail for a policy already read from the provider — one fetch, not two. */
  private detailFrom(target: IamTarget, policy: RawIamPolicyDetail): PolicyDetail {
    const name = policy.name;
    const note = this.versions.latestNote(target.row.id, name);
    const writtenAt = this.versions.lastWrittenAt(target.row.id, name);
    const id = this.entities.idFor(target.row.id, 'policy', policy.name);

    return {
      id,
      serverId: target.row.id,
      serverName: target.row.name,
      name: policy.name,
      builtIn: policy.builtIn,
      description: policy.description ?? note,
      attachedCount: policy.attachedTo.users.length + policy.attachedTo.groups.length,
      updatedAt: policy.updatedAt ?? writtenAt,
      document: policy.document,
      attachedTo: {
        users: [...policy.attachedTo.users],
        groups: [...policy.attachedTo.groups],
      },
    };
  }

  /** How many users each policy is attached to, in one listing. */
  private async attachedPoliciesOfUsers(target: IamTarget): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    try {
      const users = this.targets.providers.iamUsersFor(target.connection);
      const listed = await users.list(target.connection);
      for (const user of listed) {
        for (const policy of user.policies) counts.set(policy, (counts.get(policy) ?? 0) + 1);
      }
    } catch {
      // No user surface, or unreachable: the policies are still worth listing and
      // `attachedCount` degrades to what the groups contribute.
    }
    return counts;
  }

  private async attachedPoliciesOfGroups(target: IamTarget): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    const groups = this.targets.providers.iamGroupsIfAny(target.connection);
    if (groups === null) return counts;

    try {
      const listed = await groups.list(target.connection);
      for (const group of listed) {
        for (const policy of group.policies) counts.set(policy, (counts.get(policy) ?? 0) + 1);
      }
    } catch {
      // Same reasoning as above.
    }
    return counts;
  }
}

/** The note on the baseline snapshot, when the policy pre-dates storage-io. */
const BASELINE_NOTE = 'As it was before the first change made in storage-io';
