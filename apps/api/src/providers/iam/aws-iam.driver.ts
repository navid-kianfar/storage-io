import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  AddUserToGroupCommand,
  AttachGroupPolicyCommand,
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  CreateGroupCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteGroupCommand,
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  DeleteUserCommand,
  DetachGroupPolicyCommand,
  DetachUserPolicyCommand,
  GetAccessKeyLastUsedCommand,
  GetGroupCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetUserCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListAttachedGroupPoliciesCommand,
  ListAttachedUserPoliciesCommand,
  ListEntitiesForPolicyCommand,
  ListGroupsCommand,
  ListGroupsForUserCommand,
  ListPoliciesCommand,
  ListPolicyVersionsCommand,
  ListUsersCommand,
  NoSuchEntityException,
  RemoveUserFromGroupCommand,
  UpdateAccessKeyCommand,
} from '@aws-sdk/client-iam';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { IamDriver, JsonObject, Provider } from '@storage-io/contracts';
import {
  ConflictError,
  NotSupportedError,
  ProviderError,
} from '../../common/errors/domain.exception';
import type { IamSubDriver, RawIamUser, ServerConnection } from '../provider-driver';
import type {
  CreateRawKeyInput,
  CreateRawUserInput,
  IamAccessKeyOperations,
  IamGroupOperations,
  IamPolicyOperations,
  IamUserOperations,
  RawAccessKey,
  RawCreatedKey,
  RawIamGroup,
  RawIamPolicy,
  RawIamPolicyDetail,
  RawIamUserDetail,
  UpdateRawKeyInput,
  UpsertRawGroupInput,
} from './iam-driver';

/**
 * `aws-iam`: the IAM API through `@aws-sdk/client-iam` (3.1141.0), against
 * whatever endpoint the server was given.
 *
 * Three deployments share it, and they are not equally capable:
 *
 * - **AWS** and **Wasabi** (`iam.wasabisys.com`) implement the API this driver
 *   uses in full.
 * - **SeaweedFS** (`-iam`, its own port) implements a subset. Verified against
 *   `chrislusf/seaweedfs:3.97`: `ListUsers`, `GetUser`, `CreateUser`,
 *   `DeleteUser`, `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey`,
 *   `PutUserPolicy`, `GetUserPolicy`, `DeleteUserPolicy` and `CreatePolicy`
 *   answer; every group call, `ListPolicies`, `GetPolicy`, `DeletePolicy`,
 *   `AttachUserPolicy`, `UpdateAccessKey` and `GetAccessKeyLastUsed` answer
 *   HTTP 501 `NotImplemented`.
 *
 * Which of those a server has is not guessed here: the capability profile in
 * `provider-profiles.ts` carries it (SeaweedFS's groups and policies are
 * `not_supported` there), and anything that slips through is translated — a
 * `NotImplemented` from the service becomes `NOT_SUPPORTED`, never a 502.
 *
 * Managed policies are versioned by IAM itself, which allows at most five
 * versions per policy; an update therefore prunes the oldest non-default version
 * before adding one.
 */

/** IAM's hard limit; a sixth `CreatePolicyVersion` fails without this. */
const MAX_POLICY_VERSIONS = 5;
const POLICY_LIST_PAGE = 100;
/** Wide enough for any single deployment's IAM directory, bounded on purpose. */
const MAX_LIST_PAGES = 20;

const AWS_GLOBAL_IAM_ENDPOINT = 'https://iam.amazonaws.com';
const WASABI_IAM_ENDPOINT = 'https://iam.wasabisys.com';

const CONNECTION_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 2;

interface CachedClient {
  readonly key: string;
  readonly client: IAMClient;
}

@Injectable()
export class AwsIamDriver implements IamSubDriver, OnApplicationShutdown {
  readonly kind: IamDriver = 'aws-iam';

  private readonly log = new Logger(AwsIamDriver.name);
  private readonly clients = new Map<string, CachedClient>();

  readonly users: IamUserOperations;
  readonly groups: IamGroupOperations;
  readonly policies: IamPolicyOperations;
  readonly keys: IamAccessKeyOperations;

  constructor() {
    this.users = {
      list: (connection) => this.listUserDetails(connection),
      get: (connection, name) => this.getUser(connection, name),
      create: (connection, input) => this.createUser(connection, input),
      delete: (connection, name) => this.deleteUser(connection, name),
      // IAM has no enabled/disabled user. The service maps a status change to the
      // user's access keys instead, which is the only thing that can be turned
      // off — so this method is deliberately absent rather than a lie.
      setPolicies: (connection, name, policies) => this.setUserPolicies(connection, name, policies),
      setGroups: (connection, name, groups) => this.setUserGroups(connection, name, groups),
    };

    this.groups = {
      list: (connection) => this.listGroups(connection),
      get: (connection, name) => this.getGroup(connection, name),
      upsert: (connection, input) => this.upsertGroup(connection, input),
      delete: (connection, name) => this.deleteGroup(connection, name),
    };

    this.policies = {
      list: (connection) => this.listPolicies(connection),
      get: (connection, name) => this.getPolicy(connection, name),
      put: (connection, name, document, description) =>
        this.putPolicy(connection, name, document, description),
      delete: (connection, name) => this.deletePolicy(connection, name),
    };

    this.keys = {
      // IAM keys never expire on their own; `key_meta` plus the scheduler is what
      // makes `expiresAt` mean anything here.
      supportsNativeExpiry: false,
      supportsSessionPolicy: false,
      supportsKeyName: false,
      list: (connection, userName) => this.listKeys(connection, userName),
      get: (connection, accessKeyId) => this.getKey(connection, accessKeyId),
      create: (connection, input) => this.createKey(connection, input),
      delete: (connection, accessKeyId, userName) =>
        this.deleteKey(connection, accessKeyId, userName),
      update: (connection, accessKeyId, userName, patch) =>
        this.updateKey(connection, accessKeyId, userName, patch),
    };
  }

  async ping(connection: ServerConnection): Promise<void> {
    await this.call(connection, (iam) => iam.send(new ListUsersCommand({ MaxItems: 1 })));
  }

  async listUsers(connection: ServerConnection): Promise<readonly RawIamUser[]> {
    return this.listUserDetails(connection);
  }

  async countUsers(connection: ServerConnection): Promise<number> {
    const users = await this.listUserDetails(connection);
    return users.length;
  }

  onApplicationShutdown(): void {
    this.evictAll();
  }

  /** Called when a server's connection details change or it is removed. */
  evict(serverId: string): void {
    const cached = this.clients.get(serverId);
    if (cached === undefined) return;
    cached.client.destroy();
    this.clients.delete(serverId);
  }

  evictAll(): void {
    for (const { client } of this.clients.values()) client.destroy();
    this.clients.clear();
  }

  /* ------------------------------ users --------------------------- */

  private async listUserDetails(
    connection: ServerConnection,
  ): Promise<readonly RawIamUserDetail[]> {
    const names: { name: string; createdAt: string | null }[] = [];
    let marker: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await this.call(connection, (iam) =>
        iam.send(new ListUsersCommand({ MaxItems: POLICY_LIST_PAGE, Marker: marker })),
      );
      for (const user of response.Users ?? []) {
        if (user.UserName === undefined) continue;
        names.push({ name: user.UserName, createdAt: isoOrNull(user.CreateDate) });
      }
      if (response.IsTruncated !== true || response.Marker === undefined) break;
      marker = response.Marker;
    }

    // Policies and groups are per-user calls in IAM; run them together rather
    // than one after another, and tolerate a provider that has neither.
    return Promise.all(names.map(async (user) => this.decorateUser(connection, user)));
  }

  private async decorateUser(
    connection: ServerConnection,
    user: { readonly name: string; readonly createdAt: string | null },
  ): Promise<RawIamUserDetail> {
    const [policies, groups] = await Promise.all([
      this.attachedUserPolicies(connection, user.name).catch(() => [] as readonly string[]),
      this.groupsOfUser(connection, user.name).catch(() => [] as readonly string[]),
    ]);

    return {
      name: user.name,
      // IAM has no user status; the service derives one from the user's keys.
      status: 'unknown',
      policies,
      memberOf: groups,
      createdAt: user.createdAt,
    };
  }

  private async getUser(
    connection: ServerConnection,
    name: string,
  ): Promise<RawIamUserDetail | null> {
    try {
      const response = await this.call(connection, (iam) =>
        iam.send(new GetUserCommand({ UserName: name })),
      );
      const user = response.User;
      if (user?.UserName === undefined) return null;
      return await this.decorateUser(connection, {
        name: user.UserName,
        createdAt: isoOrNull(user.CreateDate),
      });
    } catch (error) {
      if (error instanceof NoSuchEntityException) return null;
      throw this.translate(error);
    }
  }

  private async createUser(connection: ServerConnection, input: CreateRawUserInput): Promise<void> {
    // `secret` is MinIO's way of creating a user; IAM creates the user and then a
    // key, which the service does through `keys.create`.
    await this.call(connection, (iam) => iam.send(new CreateUserCommand({ UserName: input.name })));
  }

  private async deleteUser(connection: ServerConnection, name: string): Promise<void> {
    // IAM refuses to delete a user that still has keys, policies or groups, so
    // the dependants go first. SeaweedFS is happy either way.
    const keys = await this.listKeys(connection, name).catch(() => [] as readonly RawAccessKey[]);
    for (const key of keys) {
      await this.deleteKey(connection, key.accessKeyId, name);
    }

    const policies = await this.attachedUserPolicies(connection, name).catch(
      () => [] as readonly string[],
    );
    for (const policy of policies) {
      await this.detachUserPolicy(connection, name, policy);
    }

    const groups = await this.groupsOfUser(connection, name).catch(() => [] as readonly string[]);
    for (const group of groups) {
      await this.call(connection, (iam) =>
        iam.send(new RemoveUserFromGroupCommand({ GroupName: group, UserName: name })),
      );
    }

    await this.call(connection, (iam) => iam.send(new DeleteUserCommand({ UserName: name })));
  }

  private async setUserPolicies(
    connection: ServerConnection,
    name: string,
    policies: readonly string[],
  ): Promise<void> {
    const current = await this.attachedUserPolicies(connection, name);
    const wanted = new Set(policies);

    for (const policy of policies.filter((candidate) => !current.includes(candidate))) {
      const arn = await this.policyArn(connection, policy);
      await this.call(connection, (iam) =>
        iam.send(new AttachUserPolicyCommand({ UserName: name, PolicyArn: arn })),
      );
    }
    for (const policy of current.filter((candidate) => !wanted.has(candidate))) {
      await this.detachUserPolicy(connection, name, policy);
    }
  }

  private async detachUserPolicy(
    connection: ServerConnection,
    name: string,
    policy: string,
  ): Promise<void> {
    const arn = await this.policyArn(connection, policy);
    await this.call(connection, (iam) =>
      iam.send(new DetachUserPolicyCommand({ UserName: name, PolicyArn: arn })),
    );
  }

  private async setUserGroups(
    connection: ServerConnection,
    name: string,
    groups: readonly string[],
  ): Promise<void> {
    const current = await this.groupsOfUser(connection, name);
    const wanted = new Set(groups);

    for (const group of groups.filter((candidate) => !current.includes(candidate))) {
      await this.call(connection, (iam) =>
        iam.send(new AddUserToGroupCommand({ GroupName: group, UserName: name })),
      );
    }
    for (const group of current.filter((candidate) => !wanted.has(candidate))) {
      await this.call(connection, (iam) =>
        iam.send(new RemoveUserFromGroupCommand({ GroupName: group, UserName: name })),
      );
    }
  }

  private async attachedUserPolicies(
    connection: ServerConnection,
    name: string,
  ): Promise<readonly string[]> {
    const response = await this.call(connection, (iam) =>
      iam.send(new ListAttachedUserPoliciesCommand({ UserName: name, MaxItems: POLICY_LIST_PAGE })),
    );
    return (response.AttachedPolicies ?? [])
      .map((policy) => policy.PolicyName)
      .filter((policyName): policyName is string => policyName !== undefined);
  }

  private async groupsOfUser(
    connection: ServerConnection,
    name: string,
  ): Promise<readonly string[]> {
    const response = await this.call(connection, (iam) =>
      iam.send(new ListGroupsForUserCommand({ UserName: name, MaxItems: POLICY_LIST_PAGE })),
    );
    return (response.Groups ?? [])
      .map((group) => group.GroupName)
      .filter((groupName): groupName is string => groupName !== undefined);
  }

  /* ------------------------------ groups -------------------------- */

  private async listGroups(connection: ServerConnection): Promise<readonly RawIamGroup[]> {
    const response = await this.call(connection, (iam) =>
      iam.send(new ListGroupsCommand({ MaxItems: POLICY_LIST_PAGE })),
    );
    const names = (response.Groups ?? [])
      .map((group) => group.GroupName)
      .filter((name): name is string => name !== undefined);

    const groups = await Promise.all(names.map(async (name) => this.getGroup(connection, name)));
    return groups.filter((group): group is RawIamGroup => group !== null);
  }

  private async getGroup(connection: ServerConnection, name: string): Promise<RawIamGroup | null> {
    try {
      const [members, policies] = await Promise.all([
        this.call(connection, (iam) => iam.send(new GetGroupCommand({ GroupName: name }))),
        this.call(connection, (iam) =>
          iam.send(
            new ListAttachedGroupPoliciesCommand({ GroupName: name, MaxItems: POLICY_LIST_PAGE }),
          ),
        ),
      ]);

      return {
        name,
        members: (members.Users ?? [])
          .map((user) => user.UserName)
          .filter((userName): userName is string => userName !== undefined),
        policies: (policies.AttachedPolicies ?? [])
          .map((policy) => policy.PolicyName)
          .filter((policyName): policyName is string => policyName !== undefined),
        // IAM groups have no status; the contract's enum has no "unknown", and a
        // group that exists is usable, so "enabled" is the honest answer.
        status: 'enabled',
      };
    } catch (error) {
      if (error instanceof NoSuchEntityException) return null;
      throw this.translate(error);
    }
  }

  private async upsertGroup(
    connection: ServerConnection,
    input: UpsertRawGroupInput,
  ): Promise<void> {
    const existing = await this.getGroup(connection, input.name);
    if (existing === null) {
      await this.call(connection, (iam) =>
        iam.send(new CreateGroupCommand({ GroupName: input.name })),
      );
    }

    const currentMembers = existing?.members ?? [];
    const wantedMembers = new Set(input.members);
    for (const member of input.members.filter((name) => !currentMembers.includes(name))) {
      await this.call(connection, (iam) =>
        iam.send(new AddUserToGroupCommand({ GroupName: input.name, UserName: member })),
      );
    }
    for (const member of currentMembers.filter((name) => !wantedMembers.has(name))) {
      await this.call(connection, (iam) =>
        iam.send(new RemoveUserFromGroupCommand({ GroupName: input.name, UserName: member })),
      );
    }

    const currentPolicies = existing?.policies ?? [];
    const wantedPolicies = new Set(input.policies);
    for (const policy of input.policies.filter((name) => !currentPolicies.includes(name))) {
      const arn = await this.policyArn(connection, policy);
      await this.call(connection, (iam) =>
        iam.send(new AttachGroupPolicyCommand({ GroupName: input.name, PolicyArn: arn })),
      );
    }
    for (const policy of currentPolicies.filter((name) => !wantedPolicies.has(name))) {
      const arn = await this.policyArn(connection, policy);
      await this.call(connection, (iam) =>
        iam.send(new DetachGroupPolicyCommand({ GroupName: input.name, PolicyArn: arn })),
      );
    }
  }

  private async deleteGroup(connection: ServerConnection, name: string): Promise<void> {
    const group = await this.getGroup(connection, name);
    if (group === null) return;

    for (const member of group.members) {
      await this.call(connection, (iam) =>
        iam.send(new RemoveUserFromGroupCommand({ GroupName: name, UserName: member })),
      );
    }
    for (const policy of group.policies) {
      const arn = await this.policyArn(connection, policy);
      await this.call(connection, (iam) =>
        iam.send(new DetachGroupPolicyCommand({ GroupName: name, PolicyArn: arn })),
      );
    }
    await this.call(connection, (iam) => iam.send(new DeleteGroupCommand({ GroupName: name })));
  }

  /* ----------------------------- policies ------------------------- */

  private async listPolicies(connection: ServerConnection): Promise<readonly RawIamPolicy[]> {
    const items: RawIamPolicy[] = [];
    let marker: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await this.call(connection, (iam) =>
        iam.send(
          // `Local` excludes the hundreds of AWS-managed policies, which are not
          // what this screen is for and would bury the operator's own.
          new ListPoliciesCommand({ Scope: 'Local', MaxItems: POLICY_LIST_PAGE, Marker: marker }),
        ),
      );
      for (const policy of response.Policies ?? []) {
        if (policy.PolicyName === undefined) continue;
        items.push({
          name: policy.PolicyName,
          builtIn: false,
          description: policy.Description ?? null,
          updatedAt: isoOrNull(policy.UpdateDate ?? policy.CreateDate),
        });
      }
      if (response.IsTruncated !== true || response.Marker === undefined) break;
      marker = response.Marker;
    }

    return items;
  }

  private async getPolicy(
    connection: ServerConnection,
    name: string,
  ): Promise<RawIamPolicyDetail | null> {
    const arn = await this.findPolicyArn(connection, name);
    if (arn === null) return null;

    const policy = await this.call(connection, (iam) =>
      iam.send(new GetPolicyCommand({ PolicyArn: arn })),
    );
    const versionId = policy.Policy?.DefaultVersionId;
    if (versionId === undefined) {
      throw new ProviderError(`IAM returned no default version for policy "${name}".`);
    }

    const [version, entities] = await Promise.all([
      this.call(connection, (iam) =>
        iam.send(new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: versionId })),
      ),
      this.call(connection, (iam) =>
        iam.send(new ListEntitiesForPolicyCommand({ PolicyArn: arn, MaxItems: POLICY_LIST_PAGE })),
      ),
    ]);

    return {
      name,
      builtIn: false,
      description: policy.Policy?.Description ?? null,
      updatedAt: isoOrNull(policy.Policy?.UpdateDate ?? policy.Policy?.CreateDate),
      document: parsePolicyDocument(version.PolicyVersion?.Document),
      attachedTo: {
        users: (entities.PolicyUsers ?? [])
          .map((user) => user.UserName)
          .filter((userName): userName is string => userName !== undefined),
        groups: (entities.PolicyGroups ?? [])
          .map((group) => group.GroupName)
          .filter((groupName): groupName is string => groupName !== undefined),
      },
    };
  }

  /**
   * Create, or add a version to an existing policy and make it the default. IAM
   * keeps at most five versions, so the oldest non-default one is pruned first —
   * without that, the sixth edit of a policy fails.
   */
  private async putPolicy(
    connection: ServerConnection,
    name: string,
    document: JsonObject,
    description: string | null,
  ): Promise<void> {
    const arn = await this.findPolicyArn(connection, name);
    const body = JSON.stringify(document);

    if (arn === null) {
      await this.call(connection, (iam) =>
        iam.send(
          new CreatePolicyCommand({
            PolicyName: name,
            PolicyDocument: body,
            ...(description === null ? {} : { Description: description }),
          }),
        ),
      );
      return;
    }

    await this.pruneOldestPolicyVersion(connection, arn);
    await this.call(connection, (iam) =>
      iam.send(
        new CreatePolicyVersionCommand({
          PolicyArn: arn,
          PolicyDocument: body,
          SetAsDefault: true,
        }),
      ),
    );
  }

  private async pruneOldestPolicyVersion(connection: ServerConnection, arn: string): Promise<void> {
    const response = await this.call(connection, (iam) =>
      iam.send(new ListPolicyVersionsCommand({ PolicyArn: arn, MaxItems: POLICY_LIST_PAGE })),
    );
    const versions = response.Versions ?? [];
    if (versions.length < MAX_POLICY_VERSIONS) return;

    const removable = versions
      .filter((version) => version.IsDefaultVersion !== true && version.VersionId !== undefined)
      .sort(
        (left, right) => (left.CreateDate?.getTime() ?? 0) - (right.CreateDate?.getTime() ?? 0),
      );

    const oldest = removable[0];
    if (oldest?.VersionId === undefined) {
      throw new ConflictError(
        'This policy already has five versions and none can be removed; delete a version first.',
      );
    }
    await this.call(connection, (iam) =>
      iam.send(new DeletePolicyVersionCommand({ PolicyArn: arn, VersionId: oldest.VersionId })),
    );
  }

  private async deletePolicy(connection: ServerConnection, name: string): Promise<void> {
    const arn = await this.findPolicyArn(connection, name);
    if (arn === null) return;

    const entities = await this.call(connection, (iam) =>
      iam.send(new ListEntitiesForPolicyCommand({ PolicyArn: arn, MaxItems: POLICY_LIST_PAGE })),
    );
    const attachedUsers = entities.PolicyUsers ?? [];
    const attachedGroups = entities.PolicyGroups ?? [];
    if (attachedUsers.length > 0 || attachedGroups.length > 0) {
      throw new ConflictError(
        `"${name}" is still attached to a user or group; detach it before deleting.`,
      );
    }

    // Non-default versions block the delete, so they go first.
    const versions = await this.call(connection, (iam) =>
      iam.send(new ListPolicyVersionsCommand({ PolicyArn: arn, MaxItems: POLICY_LIST_PAGE })),
    );
    for (const version of versions.Versions ?? []) {
      if (version.IsDefaultVersion === true || version.VersionId === undefined) continue;
      await this.call(connection, (iam) =>
        iam.send(new DeletePolicyVersionCommand({ PolicyArn: arn, VersionId: version.VersionId })),
      );
    }

    await this.call(connection, (iam) => iam.send(new DeletePolicyCommand({ PolicyArn: arn })));
  }

  /** The ARN of a customer-managed policy by name, or null when there is none. */
  private async findPolicyArn(connection: ServerConnection, name: string): Promise<string | null> {
    let marker: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await this.call(connection, (iam) =>
        iam.send(
          new ListPoliciesCommand({ Scope: 'Local', MaxItems: POLICY_LIST_PAGE, Marker: marker }),
        ),
      );
      const match = (response.Policies ?? []).find((policy) => policy.PolicyName === name);
      if (match?.Arn !== undefined) return match.Arn;
      if (response.IsTruncated !== true || response.Marker === undefined) break;
      marker = response.Marker;
    }
    return null;
  }

  private async policyArn(connection: ServerConnection, name: string): Promise<string> {
    const arn = await this.findPolicyArn(connection, name);
    if (arn === null) throw new ConflictError(`No policy named "${name}" on this server.`);
    return arn;
  }

  /* --------------------------- access keys ------------------------ */

  private async listKeys(
    connection: ServerConnection,
    userName?: string,
  ): Promise<readonly RawAccessKey[]> {
    if (userName !== undefined) return this.listKeysOfUser(connection, userName);

    const users = await this.listUserDetails(connection);
    const perUser = await Promise.all(
      users.map(async (user) => this.listKeysOfUser(connection, user.name)),
    );
    return perUser.flat();
  }

  private async listKeysOfUser(
    connection: ServerConnection,
    userName: string,
  ): Promise<readonly RawAccessKey[]> {
    let response;
    try {
      response = await this.call(connection, (iam) =>
        iam.send(new ListAccessKeysCommand({ UserName: userName, MaxItems: POLICY_LIST_PAGE })),
      );
    } catch (error) {
      if (error instanceof NoSuchEntityException) return [];
      throw this.translate(error);
    }

    const keys = response.AccessKeyMetadata ?? [];
    const lastUsed = await Promise.all(
      keys.map(async (key) => this.lastUsedAt(connection, key.AccessKeyId)),
    );

    return keys.map((key, index) => ({
      accessKeyId: key.AccessKeyId ?? '',
      userName: key.UserName ?? userName,
      // IAM stores no name for a key; `key_meta` supplies it.
      name: null,
      enabled: key.Status !== 'Inactive',
      restricted: false,
      createdAt: isoOrNull(key.CreateDate),
      expiresAt: null,
      lastUsedAt: lastUsed[index] ?? null,
    }));
  }

  /** `GetAccessKeyLastUsed` is absent on SeaweedFS, so a failure means "unknown". */
  private async lastUsedAt(
    connection: ServerConnection,
    accessKeyId: string | undefined,
  ): Promise<string | null> {
    if (accessKeyId === undefined) return null;
    try {
      const response = await this.call(connection, (iam) =>
        iam.send(new GetAccessKeyLastUsedCommand({ AccessKeyId: accessKeyId })),
      );
      return isoOrNull(response.AccessKeyLastUsed?.LastUsedDate);
    } catch {
      return null;
    }
  }

  private async getKey(
    connection: ServerConnection,
    accessKeyId: string,
  ): Promise<RawAccessKey | null> {
    // IAM has no "describe one key" call, so this is a scan of the directory.
    // Callers hold the user name wherever they can and pass it to `list`.
    const keys = await this.listKeys(connection);
    return keys.find((key) => key.accessKeyId === accessKeyId) ?? null;
  }

  private async createKey(
    connection: ServerConnection,
    input: CreateRawKeyInput,
  ): Promise<RawCreatedKey> {
    const response = await this.call(connection, (iam) =>
      iam.send(new CreateAccessKeyCommand({ UserName: input.userName })),
    );
    const key = response.AccessKey;
    if (key?.AccessKeyId === undefined || key.SecretAccessKey === undefined) {
      throw new ProviderError('IAM created an access key without returning its secret.');
    }
    // Expiry and name are app-tracked here — see `supportsNativeExpiry`.
    return { accessKeyId: key.AccessKeyId, secretAccessKey: key.SecretAccessKey, expiresAt: null };
  }

  private async updateKey(
    connection: ServerConnection,
    accessKeyId: string,
    userName: string,
    patch: UpdateRawKeyInput,
  ): Promise<void> {
    if (patch.enabled === undefined) return;
    await this.call(connection, (iam) =>
      iam.send(
        new UpdateAccessKeyCommand({
          UserName: userName,
          AccessKeyId: accessKeyId,
          Status: patch.enabled ? 'Active' : 'Inactive',
        }),
      ),
    );
  }

  private async deleteKey(
    connection: ServerConnection,
    accessKeyId: string,
    userName: string,
  ): Promise<void> {
    try {
      await this.call(connection, (iam) =>
        iam.send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId })),
      );
    } catch (error) {
      if (error instanceof NoSuchEntityException) return;
      throw this.translate(error);
    }
  }

  /* ------------------------------ transport ----------------------- */

  /**
   * Every call goes through here: it supplies the cached client and translates
   * the failure once, so no call site repeats a try/catch.
   *
   * The command is built inside the callback rather than passed in because a
   * generic `send(command)` wrapper loses the SDK's per-command output type —
   * `iam.send(new ListUsersCommand(…))` keeps it.
   */
  private async call<TOutput>(
    connection: ServerConnection,
    send: (client: IAMClient) => Promise<TOutput>,
  ): Promise<TOutput> {
    const client = this.clientFor(connection);
    try {
      return await send(client);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * A provider that does not implement a call must not look like a broken
   * gateway: `NotImplemented` becomes `NOT_SUPPORTED`, which is what the UI
   * already knows how to show.
   */
  private translate(error: unknown): unknown {
    if (!isServiceError(error)) return error;

    const code = error.name;
    const status = error.$metadata?.httpStatusCode;
    if (code === 'NotImplemented' || status === 501) {
      return new NotSupportedError('This storage server does not implement that IAM operation.');
    }
    if (code === 'EntityAlreadyExists') {
      return new ConflictError('That name is already taken on this server.');
    }
    if (code === 'DeleteConflict') {
      return new ConflictError(
        'Something is still attached to it; detach that first before deleting.',
      );
    }
    if (code === 'LimitExceeded') {
      return new ConflictError('The storage server refused it: an IAM limit was reached.');
    }
    return error;
  }

  /**
   * One client per server, keyed by everything that shapes it. Each holds a
   * keep-alive pool, so rebuilding it per request would open a TCP connection
   * per call.
   */
  private clientFor(connection: ServerConnection): IAMClient {
    const endpoint = endpointFor(connection);
    const key = [
      endpoint,
      connection.region,
      connection.accessKeyId,
      `${connection.secretAccessKey.length}:${connection.secretAccessKey.slice(-4)}`,
      connection.options.tlsVerify ? 'verify' : 'noverify',
      connection.options.caPem === null ? 'nocap' : `ca:${connection.options.caPem.length}`,
    ].join('|');

    const cached = this.clients.get(connection.id);
    if (cached !== undefined && cached.key === key) return cached.client;
    if (cached !== undefined) cached.client.destroy();

    if (!connection.options.tlsVerify && endpoint.startsWith('https:')) {
      this.log.warn(
        { server: connection.name },
        'TLS verification is disabled for this IAM endpoint; prefer pinning its CA with caPem',
      );
    }

    const client = new IAMClient({
      endpoint,
      region: connection.region,
      credentials: {
        accessKeyId: connection.accessKeyId,
        secretAccessKey: connection.secretAccessKey,
      },
      maxAttempts: MAX_ATTEMPTS,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
        httpAgent: new HttpAgent({ keepAlive: true }),
        httpsAgent: new HttpsAgent({
          keepAlive: true,
          rejectUnauthorized: connection.options.tlsVerify,
          ...(connection.options.caPem === null ? {} : { ca: connection.options.caPem }),
        }),
      }),
    });

    this.clients.set(connection.id, { key, client });
    return client;
  }
}

/* ------------------------------ helpers --------------------------- */

/**
 * `iamEndpoint` when the operator set one; otherwise the provider's published
 * IAM host. SeaweedFS and a generic deployment have no default — IAM lives on a
 * port only the operator knows — so the absence is reported rather than guessed.
 */
function endpointFor(connection: ServerConnection): string {
  const configured = connection.options.iamEndpoint;
  if (configured !== null && configured.length > 0) return configured;

  const fallback = DEFAULT_IAM_ENDPOINTS[connection.provider];
  if (fallback !== undefined) return fallback;

  throw new NotSupportedError(
    `This server has no IAM endpoint configured, so its users and keys cannot be managed.`,
  );
}

const DEFAULT_IAM_ENDPOINTS: Partial<Record<Provider, string>> = {
  aws: AWS_GLOBAL_IAM_ENDPOINT,
  wasabi: WASABI_IAM_ENDPOINT,
};

interface ServiceError {
  readonly name: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

function isServiceError(error: unknown): error is ServiceError {
  return error instanceof Error && '$metadata' in error;
}

const isoOrNull = (date: Date | undefined): string | null =>
  date === undefined ? null : date.toISOString();

/**
 * IAM returns a policy document URL-encoded, and SeaweedFS returns it as plain
 * JSON. Decoding is attempted and failure falls through to the raw text, because
 * a document that is already JSON contains no `%`.
 */
function parsePolicyDocument(document: string | undefined): JsonObject {
  if (document === undefined) return {};
  const text = document.includes('%') ? safeDecode(document) : document;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    // Falls through: a document we cannot parse is reported as empty rather
    // than handed to a client as a broken string.
  }
  return {};
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
