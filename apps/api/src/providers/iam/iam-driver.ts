import type { CapabilityMap, CapabilityState, JsonObject } from '@storage-io/contracts';
import type { RawIamUser, ServerConnection } from '../provider-driver';

/**
 * The IAM surface a provider's admin API offers, split into the four resources
 * the API exposes. Every group is **optional**, and so is almost every method
 * inside one: a provider that cannot do something declares it by leaving the
 * method out, and `ProviderRegistryService`/`IamDriverService` turn that into one
 * consistent `NOT_SUPPORTED`.
 *
 * That is why there are no stubs here. `garage-admin` genuinely has no groups and
 * `aws-iam` on SeaweedFS genuinely has no managed policies; a method that threw
 * would say the same thing in a worse place (at request time, with a provider's
 * error body) than an absent method and a `not_supported` capability.
 *
 * Types in this file are the *raw* provider shapes. Mapping to the contract —
 * `S3User`, `S3Group`, `PolicySummary`, `AccessKey` — is the services' job, so a
 * driver never has to know about `serverName` or app-tracked key metadata.
 */

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

/** `RawIamUser` plus what only some providers report. */
export interface RawIamUserDetail extends RawIamUser {
  readonly createdAt: string | null;
}

export interface CreateRawUserInput {
  readonly name: string;
  /**
   * MinIO creates a user *with* its secret; the AWS-shaped drivers create the
   * user and then a key, so they ignore this.
   */
  readonly secret: string | null;
}

export interface IamUserOperations {
  list(connection: ServerConnection): Promise<readonly RawIamUserDetail[]>;
  get(connection: ServerConnection, name: string): Promise<RawIamUserDetail | null>;
  create(connection: ServerConnection, input: CreateRawUserInput): Promise<void>;
  delete(connection: ServerConnection, name: string): Promise<void>;
  /** Absent where the provider has no notion of a disabled user (AWS IAM). */
  setStatus?(
    connection: ServerConnection,
    name: string,
    status: 'enabled' | 'disabled',
  ): Promise<void>;
  /** The full set, not a delta: the endpoint's contract is "these and no others". */
  setPolicies?(
    connection: ServerConnection,
    name: string,
    policies: readonly string[],
  ): Promise<void>;
  setGroups?(connection: ServerConnection, name: string, groups: readonly string[]): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

export interface RawIamGroup {
  readonly name: string;
  readonly members: readonly string[];
  readonly policies: readonly string[];
  readonly status: 'enabled' | 'disabled';
}

export interface UpsertRawGroupInput {
  readonly name: string;
  readonly members: readonly string[];
  readonly policies: readonly string[];
  readonly status?: 'enabled' | 'disabled';
}

export interface IamGroupOperations {
  list(connection: ServerConnection): Promise<readonly RawIamGroup[]>;
  get(connection: ServerConnection, name: string): Promise<RawIamGroup | null>;
  /** Create or reconcile to exactly this membership and policy set. */
  upsert(connection: ServerConnection, input: UpsertRawGroupInput): Promise<void>;
  delete(connection: ServerConnection, name: string): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Policies
 * ------------------------------------------------------------------ */

export interface RawIamPolicy {
  readonly name: string;
  readonly builtIn: boolean;
  readonly description: string | null;
  readonly updatedAt: string | null;
}

export interface RawIamPolicyDetail extends RawIamPolicy {
  readonly document: JsonObject;
  readonly attachedTo: { readonly users: readonly string[]; readonly groups: readonly string[] };
}

export interface IamPolicyOperations {
  list(connection: ServerConnection): Promise<readonly RawIamPolicy[]>;
  get(connection: ServerConnection, name: string): Promise<RawIamPolicyDetail | null>;
  /** Create or replace. `description` is dropped by providers without a field for it. */
  put(
    connection: ServerConnection,
    name: string,
    document: JsonObject,
    description: string | null,
  ): Promise<void>;
  delete(connection: ServerConnection, name: string): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Access keys
 * ------------------------------------------------------------------ */

export interface RawAccessKey {
  readonly accessKeyId: string;
  readonly userName: string;
  readonly name: string | null;
  /** As the provider reports it; expiry is applied by the service. */
  readonly enabled: boolean;
  readonly restricted: boolean;
  readonly createdAt: string | null;
  /** Only where the provider stores an expiry itself (MinIO service accounts). */
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
}

export interface CreateRawKeyInput {
  readonly userName: string;
  readonly name: string;
  readonly description: string | null;
  /** Ignored unless `supportsNativeExpiry`; otherwise the service tracks it. */
  readonly expiresAt: string | null;
  /** Session policy. Ignored unless `supportsSessionPolicy`. */
  readonly policy: JsonObject | null;
}

export interface RawCreatedKey {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly expiresAt: string | null;
}

export interface UpdateRawKeyInput {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly expiresAt?: string | null;
}

export interface IamAccessKeyOperations {
  /** The provider stores the expiry and enforces it; otherwise `key_meta` does. */
  readonly supportsNativeExpiry: boolean;
  /** The provider accepts a policy that narrows the key below its user. */
  readonly supportsSessionPolicy: boolean;
  /** The provider stores a human name/description for a key. */
  readonly supportsKeyName: boolean;

  /** Every key, or one user's when `userName` is given. */
  list(connection: ServerConnection, userName?: string): Promise<readonly RawAccessKey[]>;
  get(connection: ServerConnection, accessKeyId: string): Promise<RawAccessKey | null>;
  create(connection: ServerConnection, input: CreateRawKeyInput): Promise<RawCreatedKey>;
  delete(connection: ServerConnection, accessKeyId: string, userName: string): Promise<void>;
  /** Absent where a key cannot be changed after creation (SeaweedFS). */
  update?(
    connection: ServerConnection,
    accessKeyId: string,
    userName: string,
    patch: UpdateRawKeyInput,
  ): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Capability reporting
 * ------------------------------------------------------------------ */

/** The five IAM capabilities, so a driver reports them as one value. */
export const IAM_CAPABILITY_NAMES = [
  'iamUsers',
  'iamGroups',
  'iamPolicies',
  'accessKeys',
  'accessKeyExpiry',
] as const;
export type IamCapabilityName = (typeof IAM_CAPABILITY_NAMES)[number];

/**
 * Settles the IAM capabilities from the provider profile plus one fact: did the
 * admin/IAM endpoint answer?
 *
 * The profile already says what the provider *can* do — `not_supported` there is
 * a permanent no this must never overwrite, because a reachable endpoint does not
 * give SeaweedFS groups. What reachability decides is only whether the things the
 * provider can do are available on *this* server.
 */
export function settleIamCapabilities(base: CapabilityMap, reachable: boolean): CapabilityMap {
  const settled: Record<string, CapabilityState> = { ...base };
  for (const name of IAM_CAPABILITY_NAMES) {
    const profile = base[name];
    if (profile === 'not_supported') continue;
    settled[name] = reachable ? 'supported' : 'not_configured';
  }
  return settled as CapabilityMap;
}

/** The four groups, as a driver exposes them. */
export interface IamOperationGroups {
  readonly users?: IamUserOperations;
  readonly groups?: IamGroupOperations;
  readonly policies?: IamPolicyOperations;
  readonly keys?: IamAccessKeyOperations;
}

/**
 * A provider's JSON list, or an empty one.
 *
 * `Array.isArray` widens a `readonly T[]` to `any[]`, which then leaks `any`
 * through every map over it — so the check and the one cast are written out here,
 * where the value is what it is: JSON from a remote server that is *supposed* to be
 * an array.
 */
export function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}
