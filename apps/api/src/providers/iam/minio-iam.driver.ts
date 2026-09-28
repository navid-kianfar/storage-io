import { Logger } from '@nestjs/common';
import type { IamDriver, JsonObject } from '@storage-io/contracts';
import { ConflictError, ProviderError } from '../../common/errors/domain.exception';
import { MinioAdminError, type MinioAdminClient } from '../minio/minio-admin.client';
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
import { asArray } from './iam-driver';

/**
 * `minio-admin`: users, groups, canned policies and service accounts over the
 * MinIO Admin API v3.
 *
 * Every path and payload below was verified against MinIO
 * DEVELOPMENT.2025-05-24T17-08-30Z (the pinned dev container). Three of its
 * behaviours shape this file:
 *
 * 1. **Which bodies are encrypted is not uniform.** `add-user`,
 *    `idp/builtin/policy/{attach,detach}`, `add-service-account` and
 *    `update-service-account` take a madmin envelope; `add-canned-policy` and
 *    `update-group-members` take plain JSON. The transport encrypts on request
 *    (`encryptedBody`) and decrypts on sniff, so this is the only place the
 *    difference is recorded.
 * 2. **`idp/builtin/policy/attach` is newer than the API itself.** Servers before
 *    RELEASE.2023-05-04 answer 404/501 there, so a failure falls back to
 *    `set-user-or-group-policy`, which replaces the whole set in one call. The
 *    probe result is cached per server so the fallback costs one extra call once.
 * 3. **A service account keeps its policy text but loses `impliedPolicy: false`
 *    after any `update-service-account`.** `restricted` is therefore not trusted
 *    from `info-service-account` alone; the service treats `key_meta` as the
 *    authority and this driver reports what MinIO says as the fallback.
 *
 * MinIO's own policies cannot be edited or removed, which is what `builtIn` marks.
 */

/** MinIO ships these and refuses to change or remove them. */
export const MINIO_BUILT_IN_POLICIES: readonly string[] = [
  'consoleAdmin',
  'diagnostics',
  'readonly',
  'readwrite',
  'writeonly',
];

const NO_SUCH_USER = 'XMinioAdminNoSuchUser';
const NO_SUCH_GROUP = 'XMinioAdminNoSuchGroup';
const NO_SUCH_POLICY = 'XMinioAdminNoSuchPolicy';
const NO_SUCH_SERVICE_ACCOUNT = 'XMinioInvalidIAMCredentials';
const POLICY_IN_USE = 'XMinioIAMPolicyInUse';
const POLICY_CHANGE_NO_EFFECT = 'XMinioAdminPolicyChangeAlreadyApplied';

/* --------------------- Admin API response shapes ------------------ *
 * Only the fields storage-io uses; nothing is passed through unmapped.
 * ------------------------------------------------------------------ */

interface AdminUserInfo {
  readonly status?: string;
  readonly policyName?: string;
  readonly memberOf?: readonly string[];
  readonly updatedAt?: string;
}

interface AdminGroupDesc {
  readonly name?: string;
  readonly status?: string;
  readonly members?: readonly string[];
  readonly policy?: string;
  readonly updatedAt?: string;
}

interface AdminServiceAccount {
  readonly parentUser?: string;
  readonly accountStatus?: string;
  readonly impliedPolicy?: boolean;
  readonly accessKey?: string;
  readonly name?: string;
  readonly description?: string;
  readonly expiration?: string;
}

interface AdminServiceAccountList {
  /** MinIO answers `null`, not `[]`, when the user has none. */
  readonly accounts?: readonly AdminServiceAccount[] | null;
}

interface AdminNewServiceAccount {
  readonly credentials?: {
    readonly accessKey?: string;
    readonly secretKey?: string;
    readonly expiration?: string;
  };
}

/**
 * The two dates MinIO sends for "no expiry", both verified against the dev
 * container: Go's zero time from `info-service-account`, and the Unix epoch from
 * `add-service-account`/`list-service-accounts`. Taken literally either one makes a
 * brand-new key read as expired.
 */
const NEVER_EXPIRES_PREFIXES: readonly string[] = ['0001-01-01', '1970-01-01T00:00:00'];

export class MinioIamDriver implements IamSubDriver {
  readonly kind: IamDriver = 'minio-admin';

  private readonly log = new Logger(MinioIamDriver.name);
  /** Per-server: does this MinIO have the idp/builtin attach endpoint? */
  private readonly hasAttachEndpoint = new Map<string, boolean>();

  readonly users: IamUserOperations;
  readonly groups: IamGroupOperations;
  readonly policies: IamPolicyOperations;
  readonly keys: IamAccessKeyOperations;

  constructor(private readonly admin: MinioAdminClient) {
    this.users = {
      list: (connection) => this.listUserDetails(connection),
      get: (connection, name) => this.getUser(connection, name),
      create: (connection, input) => this.createUser(connection, input),
      delete: (connection, name) => this.deleteUser(connection, name),
      setStatus: (connection, name, status) => this.setUserStatus(connection, name, status),
      setPolicies: (connection, name, policies) =>
        this.setPolicies(connection, { user: name }, policies),
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
      put: (connection, name, document) => this.putPolicy(connection, name, document),
      delete: (connection, name) => this.deletePolicy(connection, name),
    };

    this.keys = {
      supportsNativeExpiry: true,
      supportsSessionPolicy: true,
      supportsKeyName: true,
      list: (connection, userName) => this.listKeys(connection, userName),
      get: (connection, accessKeyId) => this.getKey(connection, accessKeyId),
      create: (connection, input) => this.createKey(connection, input),
      delete: (connection, accessKeyId) => this.deleteKey(connection, accessKeyId),
      update: (connection, accessKeyId, _userName, patch) =>
        this.updateKey(connection, accessKeyId, patch),
    };
  }

  async ping(connection: ServerConnection): Promise<void> {
    await this.admin.json(connection, '/info');
  }

  /** The cheap path the server list and dashboard use. */
  async listUsers(connection: ServerConnection): Promise<readonly RawIamUser[]> {
    return this.listUserDetails(connection);
  }

  async countUsers(connection: ServerConnection): Promise<number> {
    const users = await this.listUserDetails(connection);
    return users.length;
  }

  /* ------------------------------ users --------------------------- */

  private async listUserDetails(
    connection: ServerConnection,
  ): Promise<readonly RawIamUserDetail[]> {
    const users = await this.admin.json<Record<string, AdminUserInfo>>(connection, '/list-users');
    return Object.entries(users).map(([name, user]) => toUserDetail(name, user));
  }

  private async getUser(
    connection: ServerConnection,
    name: string,
  ): Promise<RawIamUserDetail | null> {
    try {
      const user = await this.admin.json<AdminUserInfo>(connection, '/user-info', {
        query: { accessKey: name },
      });
      return toUserDetail(name, user);
    } catch (error) {
      if (isMinioCode(error, NO_SUCH_USER)) return null;
      throw error;
    }
  }

  private async createUser(connection: ServerConnection, input: CreateRawUserInput): Promise<void> {
    if (input.secret === null) {
      throw new ProviderError('MinIO needs a secret key to create a user.');
    }
    const body = JSON.stringify({ secretKey: input.secret, status: 'enabled' });
    await this.admin.request(connection, '/add-user', {
      method: 'PUT',
      query: { accessKey: input.name },
      encryptedBody: Buffer.from(body, 'utf8'),
    });
  }

  private async deleteUser(connection: ServerConnection, name: string): Promise<void> {
    // MinIO removes the user's service accounts with it; the caller prunes
    // key_meta so storage-io does not keep rows for keys that no longer exist.
    await this.admin.request(connection, '/remove-user', {
      method: 'DELETE',
      query: { accessKey: name },
    });
  }

  private async setUserStatus(
    connection: ServerConnection,
    name: string,
    status: 'enabled' | 'disabled',
  ): Promise<void> {
    await this.admin.request(connection, '/set-user-status', {
      method: 'PUT',
      query: { accessKey: name, status },
    });
  }

  private async setUserGroups(
    connection: ServerConnection,
    name: string,
    groups: readonly string[],
  ): Promise<void> {
    const current = await this.getUser(connection, name);
    if (current === null) throw new ProviderError(`MinIO has no user named "${name}".`);

    const wanted = new Set(groups);
    const existing = new Set(current.memberOf);

    const toAdd = groups.filter((group) => !existing.has(group));
    const toRemove = current.memberOf.filter((group) => !wanted.has(group));

    for (const group of toAdd) {
      await this.updateGroupMembers(connection, group, [name], false);
    }
    for (const group of toRemove) {
      await this.updateGroupMembers(connection, group, [name], true);
    }
  }

  /* ----------------------- policy attachment ---------------------- */

  /**
   * Replaces the whole attached set for a user or a group.
   *
   * The modern endpoint attaches and detaches deltas; the legacy one takes a
   * comma-joined list and replaces. Both end at the same state, and the delta
   * form is preferred because it does not clobber a policy attached by someone
   * else between the read and the write.
   */
  private async setPolicies(
    connection: ServerConnection,
    target: { readonly user: string } | { readonly group: string },
    policies: readonly string[],
  ): Promise<void> {
    const currentAttached = await this.attachedPoliciesOf(connection, target);
    const wanted = new Set(policies);
    const toAttach = policies.filter((policy) => !currentAttached.includes(policy));
    const toDetach = currentAttached.filter((policy) => !wanted.has(policy));

    if (toAttach.length === 0 && toDetach.length === 0) return;

    if (await this.supportsAttachEndpoint(connection)) {
      if (toAttach.length > 0) await this.attachOrDetach(connection, 'attach', target, toAttach);
      if (toDetach.length > 0) await this.attachOrDetach(connection, 'detach', target, toDetach);
      return;
    }

    await this.setPoliciesLegacy(connection, target, policies);
  }

  private async attachOrDetach(
    connection: ServerConnection,
    action: 'attach' | 'detach',
    target: { readonly user: string } | { readonly group: string },
    policies: readonly string[],
  ): Promise<void> {
    const body = JSON.stringify({ policies, ...target });
    try {
      await this.admin.request(connection, `/idp/builtin/policy/${action}`, {
        method: 'POST',
        encryptedBody: Buffer.from(body, 'utf8'),
      });
    } catch (error) {
      // "Already in effect" means the desired state is the current state, which
      // is success as far as a full-set PUT is concerned.
      if (isMinioCode(error, POLICY_CHANGE_NO_EFFECT)) return;
      throw error;
    }
  }

  /**
   * `set-user-or-group-policy`, for servers without the idp endpoints. It takes a
   * comma-joined list and an empty string clears the set.
   */
  private async setPoliciesLegacy(
    connection: ServerConnection,
    target: { readonly user: string } | { readonly group: string },
    policies: readonly string[],
  ): Promise<void> {
    const isGroup = 'group' in target;
    await this.admin.request(connection, '/set-user-or-group-policy', {
      method: 'PUT',
      query: {
        policyName: policies.join(','),
        userOrGroup: isGroup ? target.group : target.user,
        isGroup: isGroup ? 'true' : 'false',
      },
    });
  }

  private async attachedPoliciesOf(
    connection: ServerConnection,
    target: { readonly user: string } | { readonly group: string },
  ): Promise<readonly string[]> {
    if ('group' in target) {
      const group = await this.getGroup(connection, target.group);
      return group?.policies ?? [];
    }
    const user = await this.getUser(connection, target.user);
    return user?.policies ?? [];
  }

  /**
   * One probe per server, cached: a 404/501 from the attach endpoint means an
   * older MinIO, and there is no version field that answers this reliably (the
   * endpoint exists in forks that report older releases).
   */
  private async supportsAttachEndpoint(connection: ServerConnection): Promise<boolean> {
    const cached = this.hasAttachEndpoint.get(connection.id);
    if (cached !== undefined) return cached;

    try {
      // An empty policy list is a no-op the server still routes, so it answers
      // the routing question without changing anything.
      await this.admin.request(connection, '/idp/builtin/policy/attach', {
        method: 'POST',
        encryptedBody: Buffer.from(JSON.stringify({ policies: [], user: '' }), 'utf8'),
      });
      this.hasAttachEndpoint.set(connection.id, true);
      return true;
    } catch (error) {
      const missing =
        error instanceof MinioAdminError &&
        (error.httpStatus === 404 || error.httpStatus === 501) &&
        error.minioCode === null;
      if (missing) {
        this.log.log(
          { server: connection.name },
          'MinIO has no idp/builtin/policy/attach; using set-user-or-group-policy',
        );
      }
      // Any other error (including a validation complaint about the empty
      // request) proves the route exists.
      this.hasAttachEndpoint.set(connection.id, !missing);
      return !missing;
    }
  }

  /* ------------------------------ groups -------------------------- */

  private async listGroups(connection: ServerConnection): Promise<readonly RawIamGroup[]> {
    const response = await this.admin.json<unknown>(connection, '/groups');
    const names = asArray<string>(response);

    // One call per group is what the admin API offers — there is no bulk group
    // description endpoint — but they run together rather than in sequence.
    const descriptions = await Promise.all(
      names.map(async (name) => this.getGroup(connection, name)),
    );
    return descriptions.filter((group): group is RawIamGroup => group !== null);
  }

  private async getGroup(connection: ServerConnection, name: string): Promise<RawIamGroup | null> {
    try {
      const group = await this.admin.json<AdminGroupDesc>(connection, '/group', {
        query: { group: name },
      });
      return {
        name: group.name ?? name,
        members: group.members ?? [],
        policies: splitPolicies(group.policy),
        status: group.status === 'disabled' ? 'disabled' : 'enabled',
      };
    } catch (error) {
      if (isMinioCode(error, NO_SUCH_GROUP)) return null;
      throw error;
    }
  }

  /**
   * MinIO has no "create group" call: a group exists because it has members. So
   * an upsert reconciles membership first — which creates the group on the first
   * add — and then the policy set.
   */
  private async upsertGroup(
    connection: ServerConnection,
    input: UpsertRawGroupInput,
  ): Promise<void> {
    const existing = await this.getGroup(connection, input.name);
    const current = existing?.members ?? [];
    const wanted = new Set(input.members);

    const toAdd = input.members.filter((member) => !current.includes(member));
    const toRemove = current.filter((member) => !wanted.has(member));

    if (toAdd.length > 0) await this.updateGroupMembers(connection, input.name, toAdd, false);
    if (toRemove.length > 0) {
      await this.updateGroupMembers(connection, input.name, toRemove, true);
    }
    if (existing === null && input.members.length === 0) {
      throw new ProviderError('MinIO creates a group from its first member, so add at least one.');
    }

    await this.setPolicies(connection, { group: input.name }, input.policies);

    if (input.status === undefined) return;
    await this.admin.request(connection, '/set-group-status', {
      method: 'PUT',
      query: { group: input.name, status: input.status },
    });
  }

  private async deleteGroup(connection: ServerConnection, name: string): Promise<void> {
    const group = await this.getGroup(connection, name);
    if (group === null) return;

    // Detach first: MinIO refuses to remove a policy that is in use, and a group
    // with an attached policy is not removable either.
    await this.setPolicies(connection, { group: name }, []);
    if (group.members.length > 0) {
      await this.updateGroupMembers(connection, name, group.members, true);
    }
    // An empty remove on an empty group is what deletes it.
    await this.updateGroupMembers(connection, name, [], true);
  }

  private async updateGroupMembers(
    connection: ServerConnection,
    group: string,
    members: readonly string[],
    isRemove: boolean,
  ): Promise<void> {
    // Plain JSON, not a madmin envelope — verified against the dev container.
    const body = JSON.stringify({ group, members, isRemove });
    await this.admin.request(connection, '/update-group-members', {
      method: 'PUT',
      body: Buffer.from(body, 'utf8'),
    });
  }

  /* ----------------------------- policies ------------------------- */

  private async listPolicies(connection: ServerConnection): Promise<readonly RawIamPolicy[]> {
    const policies = await this.admin.json<Record<string, unknown>>(
      connection,
      '/list-canned-policies',
    );
    return Object.keys(policies).map((name) => ({
      name,
      builtIn: MINIO_BUILT_IN_POLICIES.includes(name),
      // MinIO stores no description or timestamp for a canned policy; the app
      // database supplies both from its own snapshots.
      description: null,
      updatedAt: null,
    }));
  }

  private async getPolicy(
    connection: ServerConnection,
    name: string,
  ): Promise<RawIamPolicyDetail | null> {
    let document: JsonObject;
    try {
      document = await this.admin.json<JsonObject>(connection, '/info-canned-policy', {
        query: { name },
      });
    } catch (error) {
      if (isMinioCode(error, NO_SUCH_POLICY)) return null;
      throw error;
    }

    const [users, groups] = await Promise.all([
      this.listUserDetails(connection),
      this.listGroups(connection),
    ]);

    return {
      name,
      builtIn: MINIO_BUILT_IN_POLICIES.includes(name),
      description: null,
      updatedAt: null,
      document,
      attachedTo: {
        users: users.filter((user) => user.policies.includes(name)).map((user) => user.name),
        groups: groups.filter((group) => group.policies.includes(name)).map((group) => group.name),
      },
    };
  }

  private async putPolicy(
    connection: ServerConnection,
    name: string,
    document: JsonObject,
  ): Promise<void> {
    // Plain JSON body; `add-canned-policy` replaces an existing policy.
    await this.admin.request(connection, '/add-canned-policy', {
      method: 'PUT',
      query: { name },
      body: Buffer.from(JSON.stringify(document), 'utf8'),
    });
  }

  private async deletePolicy(connection: ServerConnection, name: string): Promise<void> {
    try {
      await this.admin.request(connection, '/remove-canned-policy', {
        method: 'DELETE',
        query: { name },
      });
    } catch (error) {
      if (isMinioCode(error, POLICY_IN_USE)) {
        throw new ConflictError(
          `"${name}" is still attached to a user or group; detach it before deleting.`,
        );
      }
      if (isMinioCode(error, NO_SUCH_POLICY)) return;
      throw error;
    }
  }

  /* --------------------------- access keys ------------------------ */

  private async listKeys(
    connection: ServerConnection,
    userName?: string,
  ): Promise<readonly RawAccessKey[]> {
    if (userName !== undefined) return this.listKeysOfUser(connection, userName);

    // MinIO's list-service-accounts answers for one parent user at a time, so a
    // full list is one call per user. The users come from a single list-users.
    const users = await this.listUserDetails(connection);
    const owners = new Set(users.map((user) => user.name));

    // `list-users` does not include the root user, so a service account whose
    // parent is root — which is what storage-io's own credential rotation creates —
    // would be invisible in the keys list. The identity this connection
    // authenticates as is therefore always asked about as well.
    owners.add(await this.ownIdentityOf(connection));

    const perOwner = await Promise.all(
      [...owners].map(async (owner) => this.listKeysOfUser(connection, owner)),
    );

    // The same key can come back under two owners when the connection's own
    // identity is also a listed user, so they are deduplicated by key id.
    const byId = new Map<string, RawAccessKey>();
    for (const key of perOwner.flat()) byId.set(key.accessKeyId, key);
    return [...byId.values()];
  }

  /**
   * The identity this connection acts as — the parent user when the stored
   * credential is itself a service account, and the access key id otherwise (the
   * root user, or a plain user's own key).
   *
   * It matters because `list-service-accounts` keys on the *parent*: after
   * storage-io rotates its own credential to a root service account, asking about
   * that service account's id returns nothing, and every root-owned key would drop
   * out of the list.
   */
  private async ownIdentityOf(connection: ServerConnection): Promise<string> {
    const own = await this.getKey(connection, connection.accessKeyId);
    if (own !== null && own.userName.length > 0) return own.userName;
    return connection.accessKeyId;
  }

  private async listKeysOfUser(
    connection: ServerConnection,
    userName: string,
  ): Promise<readonly RawAccessKey[]> {
    let response: AdminServiceAccountList;
    try {
      response = await this.admin.json<AdminServiceAccountList>(
        connection,
        '/list-service-accounts',
        { query: { user: userName } },
      );
    } catch (error) {
      if (isMinioCode(error, NO_SUCH_USER)) return [];
      throw error;
    }

    const accounts = response.accounts ?? [];
    return accounts.map((account) => toRawKey(account, userName));
  }

  private async getKey(
    connection: ServerConnection,
    accessKeyId: string,
  ): Promise<RawAccessKey | null> {
    try {
      const account = await this.admin.json<AdminServiceAccount>(
        connection,
        '/info-service-account',
        { query: { accessKey: accessKeyId } },
      );
      return toRawKey({ ...account, accessKey: accessKeyId }, account.parentUser ?? '');
    } catch (error) {
      if (isMinioCode(error, NO_SUCH_SERVICE_ACCOUNT)) return null;
      throw error;
    }
  }

  private async createKey(
    connection: ServerConnection,
    input: CreateRawKeyInput,
  ): Promise<RawCreatedKey> {
    const body: Record<string, unknown> = {
      targetUser: input.userName,
      name: input.name,
    };
    if (input.description !== null) body['description'] = input.description;
    if (input.expiresAt !== null) body['expiration'] = input.expiresAt;
    if (input.policy !== null) body['policy'] = input.policy;

    const created = await this.admin.json<AdminNewServiceAccount>(
      connection,
      '/add-service-account',
      { method: 'PUT', encryptedBody: Buffer.from(JSON.stringify(body), 'utf8') },
    );

    const credentials = created.credentials;
    if (credentials?.accessKey === undefined || credentials.secretKey === undefined) {
      throw new ProviderError('MinIO created a service account without returning its credentials.');
    }

    return {
      accessKeyId: credentials.accessKey,
      secretAccessKey: credentials.secretKey,
      expiresAt: usableTime(credentials.expiration),
    };
  }

  private async updateKey(
    connection: ServerConnection,
    accessKeyId: string,
    patch: UpdateRawKeyInput,
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body['newName'] = patch.name;
    if (patch.enabled !== undefined) body['newStatus'] = patch.enabled ? 'on' : 'off';
    if (patch.expiresAt !== undefined && patch.expiresAt !== null) {
      body['newExpiration'] = patch.expiresAt;
    }
    if (Object.keys(body).length === 0) return;

    await this.admin.request(connection, '/update-service-account', {
      method: 'POST',
      query: { accessKey: accessKeyId },
      encryptedBody: Buffer.from(JSON.stringify(body), 'utf8'),
    });
  }

  private async deleteKey(connection: ServerConnection, accessKeyId: string): Promise<void> {
    try {
      await this.admin.request(connection, '/delete-service-account', {
        method: 'DELETE',
        query: { accessKey: accessKeyId },
      });
    } catch (error) {
      if (isMinioCode(error, NO_SUCH_SERVICE_ACCOUNT)) return;
      throw error;
    }
  }
}

/* ------------------------------ helpers --------------------------- */

export function isMinioCode(error: unknown, code: string): boolean {
  return error instanceof MinioAdminError && error.minioCode === code;
}

function toUserDetail(name: string, user: AdminUserInfo): RawIamUserDetail {
  return {
    name,
    status:
      user.status === 'enabled' ? 'enabled' : user.status === 'disabled' ? 'disabled' : 'unknown',
    policies: splitPolicies(user.policyName),
    memberOf: user.memberOf ?? [],
    // MinIO reports no creation time for a user, only an `updatedAt` that is the
    // Go zero time until something changes it.
    createdAt: null,
  };
}

function toRawKey(account: AdminServiceAccount, fallbackUser: string): RawAccessKey {
  return {
    accessKeyId: account.accessKey ?? '',
    userName: account.parentUser ?? fallbackUser,
    name: account.name !== undefined && account.name.length > 0 ? account.name : null,
    enabled: account.accountStatus !== 'off',
    // MinIO drops `impliedPolicy: false` after any update-service-account call,
    // so this is a floor, not the truth; key_meta is the authority.
    restricted: account.impliedPolicy === false,
    createdAt: null,
    expiresAt: usableTime(account.expiration),
    lastUsedAt: null,
  };
}

/** MinIO sends Go's zero time for "never"; the contract wants null. */
function usableTime(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  if (NEVER_EXPIRES_PREFIXES.some((prefix) => value.startsWith(prefix))) return null;
  if (Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** MinIO joins several attached policies with commas in one field. */
function splitPolicies(policyName: string | undefined): readonly string[] {
  if (policyName === undefined || policyName.length === 0) return [];
  return policyName
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
