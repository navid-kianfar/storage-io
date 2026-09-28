import type {
  AccessKeyBulkRequest,
  AccessKeyBulkResponse,
  IamUserBulkRequest,
  IamUserBulkResponse,
  AccessKey,
  AccessKeyList,
  CreateAccessKeyRequest,
  CreateS3UserRequest,
  CreateS3UserResponse,
  CreatedKey,
  ListAccessKeysQuery,
  ListIamGroupsQuery,
  ListIamPoliciesQuery,
  ListIamUsersQuery,
  PolicyDetail,
  PolicyList,
  PolicyVersionList,
  PutPolicyRequest,
  RotateAccessKeyRequest,
  S3Group,
  S3GroupList,
  S3UserDetail,
  S3UserList,
  SimulatePolicyRequest,
  SimulatePolicyResponse,
  UpdateAccessKeyRequest,
  UpsertS3GroupRequest,
  ValidatePolicyRequest,
  ValidatePolicyResponse,
} from '@storage-io/contracts';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * Every IAM request the three access pages make: S3 users, groups, policies and
 * access keys.
 *
 * One module because they are one domain on the server — `/iam/*` for the
 * aggregated reads and `/servers/:sid/iam/*` for the writes — and because the
 * writes cross: creating a user can create a key, attaching a policy changes a
 * user, and deleting a user removes its keys. Every mutation therefore invalidates
 * the whole `iam` scope rather than guessing which list it touched; the scope is
 * four short lists, so the refetch is cheap and the alternative is a stale table
 * after an action that plainly changed it.
 *
 * The aggregated lists carry `unavailable`, and no page may drop it: a server that
 * failed to answer is named on the page, because "no users" and "we could not ask"
 * are different answers.
 */

function iamPath(serverId: string, suffix: string): string {
  return `/servers/${encodeURIComponent(serverId)}/iam/${suffix}`;
}

function useIamInvalidation(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.iam.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
  };
}

/* ---------------------------- resolve by id ------------------------------ */

/**
 * The resolve endpoints, which take the opaque id a URL carries and return the
 * whole entity (docs/ROUTES.md). A page reached by id calls one of these and gets
 * both halves in one request: what to render, and the `serverId` + `name` every
 * other IAM endpoint is addressed by.
 *
 * They share the `entities` query scope with `lib/entities/resolve`, so a page and
 * its breadcrumb resolve the same id once between them.
 */
const RESOLVE_STALE_MS = 5 * 60_000;

function useResolveById<T>(kind: string, id: string | undefined, path: string) {
  return useQuery<T>({
    queryKey: queryKeys.entities.byId(kind, id ?? ''),
    queryFn: ({ signal }) => api.get<T>(path, undefined, signal),
    enabled: id !== undefined && id !== '',
    staleTime: RESOLVE_STALE_MS,
    retry: false,
  });
}

export function useIamUserById(userId: string | undefined): UseQueryResult<S3UserDetail> {
  return useResolveById<S3UserDetail>('user', userId, `/iam/users/${encodeURIComponent(userId ?? '')}`);
}

export function useIamGroupById(groupId: string | undefined): UseQueryResult<S3Group> {
  return useResolveById<S3Group>('group', groupId, `/iam/groups/${encodeURIComponent(groupId ?? '')}`);
}

export function useIamPolicyById(policyId: string | undefined): UseQueryResult<PolicyDetail> {
  return useResolveById<PolicyDetail>(
    'policy',
    policyId,
    `/iam/policies/${encodeURIComponent(policyId ?? '')}`,
  );
}

export function useAccessKeyById(keyId: string | undefined): UseQueryResult<AccessKey> {
  return useResolveById<AccessKey>(
    'key',
    keyId,
    `/iam/access-keys/${encodeURIComponent(keyId ?? '')}`,
  );
}

/* ------------------------------- S3 users -------------------------------- */

export function useIamUsers(filters: ListIamUsersQuery): UseQueryResult<S3UserList> {
  return useQuery({
    queryKey: queryKeys.iam.users(filters),
    queryFn: ({ signal }) => api.get<S3UserList>('/iam/users', { ...filters }, signal),
  });
}

export interface UserRef {
  readonly serverId: string;
  readonly name: string;
}

export function useIamUser(ref: UserRef | null): UseQueryResult<S3UserDetail> {
  return useQuery({
    queryKey: queryKeys.iam.user(ref?.serverId ?? '', ref?.name ?? ''),
    queryFn: ({ signal }) =>
      api.get<S3UserDetail>(
        iamPath(ref?.serverId ?? '', `users/${encodeURIComponent(ref?.name ?? '')}`),
        undefined,
        signal,
      ),
    enabled: ref !== null,
  });
}

export interface CreateUserVariables extends CreateS3UserRequest {
  readonly serverId: string;
}

export function useCreateIamUser(): UseMutationResult<
  CreateS3UserResponse,
  Error,
  CreateUserVariables
> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, ...body }) =>
      api.post<CreateS3UserResponse>(iamPath(serverId, 'users'), body),
    onSuccess: invalidate,
  });
}

export interface SetUserStatusVariables extends UserRef {
  readonly status: 'enabled' | 'disabled';
}

export function useSetIamUserStatus(): UseMutationResult<
  S3UserDetail,
  Error,
  SetUserStatusVariables
> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, name, status }) =>
      api.patch<S3UserDetail>(iamPath(serverId, `users/${encodeURIComponent(name)}`), { status }),
    onSuccess: invalidate,
  });
}

export interface SetUserPoliciesVariables extends UserRef {
  readonly policies: readonly string[];
}

export function useSetIamUserPolicies(): UseMutationResult<
  S3UserDetail,
  Error,
  SetUserPoliciesVariables
> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, name, policies }) =>
      api.put<S3UserDetail>(iamPath(serverId, `users/${encodeURIComponent(name)}/policies`), {
        policies: [...policies],
      }),
    onSuccess: invalidate,
  });
}

export interface SetUserGroupsVariables extends UserRef {
  readonly groups: readonly string[];
}

export function useSetIamUserGroups(): UseMutationResult<
  S3UserDetail,
  Error,
  SetUserGroupsVariables
> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, name, groups }) =>
      api.put<S3UserDetail>(iamPath(serverId, `users/${encodeURIComponent(name)}/groups`), {
        groups: [...groups],
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteIamUser(): UseMutationResult<void, Error, UserRef> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, name }) =>
      api.delete<void>(iamPath(serverId, `users/${encodeURIComponent(name)}`)),
    onSuccess: invalidate,
  });
}

/* ------------------------------ bulk actions ----------------------------- */

/**
 * `POST /iam/users/bulk` and `POST /iam/access-keys/bulk`.
 *
 * A bulk action is **one** request. The lists send the opaque ids they already
 * have, the API resolves them and reports one row per target, so a partial
 * failure names the rows it did not reach instead of leaving the operator to
 * guess which of forty requests failed.
 */
export function useIamUserBulk(): UseMutationResult<
  IamUserBulkResponse,
  Error,
  IamUserBulkRequest
> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: (body) => api.post<IamUserBulkResponse>('/iam/users/bulk', body),
    onSuccess: invalidate,
  });
}

export function useAccessKeyBulk(): UseMutationResult<
  AccessKeyBulkResponse,
  Error,
  AccessKeyBulkRequest
> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: (body) => api.post<AccessKeyBulkResponse>('/iam/access-keys/bulk', body),
    onSuccess: invalidate,
  });
}

/* -------------------------------- groups --------------------------------- */

export function useIamGroups(filters: ListIamGroupsQuery): UseQueryResult<S3GroupList> {
  return useQuery({
    queryKey: queryKeys.iam.groups(filters),
    queryFn: ({ signal }) => api.get<S3GroupList>('/iam/groups', { ...filters }, signal),
  });
}

export interface UpsertGroupVariables extends UpsertS3GroupRequest {
  readonly serverId: string;
  /** The group's current name; absent when creating. */
  readonly existingName?: string;
}

export function useUpsertIamGroup(): UseMutationResult<S3Group, Error, UpsertGroupVariables> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, existingName, ...body }) =>
      existingName === undefined
        ? api.post<S3Group>(iamPath(serverId, 'groups'), body)
        : api.patch<S3Group>(iamPath(serverId, `groups/${encodeURIComponent(existingName)}`), body),
    onSuccess: invalidate,
  });
}

export function useDeleteIamGroup(): UseMutationResult<void, Error, UserRef> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, name }) =>
      api.delete<void>(iamPath(serverId, `groups/${encodeURIComponent(name)}`)),
    onSuccess: invalidate,
  });
}

/* -------------------------------- policies ------------------------------- */

export function useIamPolicies(filters: ListIamPoliciesQuery): UseQueryResult<PolicyList> {
  return useQuery({
    queryKey: queryKeys.iam.policies(filters),
    queryFn: ({ signal }) => api.get<PolicyList>('/iam/policies', { ...filters }, signal),
  });
}

export interface PolicyRef {
  readonly serverId: string;
  readonly name: string;
}

export function useIamPolicy(ref: PolicyRef | null): UseQueryResult<PolicyDetail> {
  return useQuery({
    queryKey: queryKeys.iam.policy(ref?.serverId ?? '', ref?.name ?? ''),
    queryFn: ({ signal }) =>
      api.get<PolicyDetail>(
        iamPath(ref?.serverId ?? '', `policies/${encodeURIComponent(ref?.name ?? '')}`),
        undefined,
        signal,
      ),
    enabled: ref !== null,
  });
}

export function useIamPolicyVersions(ref: PolicyRef | null): UseQueryResult<PolicyVersionList> {
  return useQuery({
    queryKey: queryKeys.iam.policyVersions(ref?.serverId ?? '', ref?.name ?? ''),
    queryFn: ({ signal }) =>
      api.get<PolicyVersionList>(
        iamPath(ref?.serverId ?? '', `policies/${encodeURIComponent(ref?.name ?? '')}/versions`),
        undefined,
        signal,
      ),
    enabled: ref !== null,
  });
}

export interface PutPolicyVariables extends PolicyRef, PutPolicyRequest {}

export function usePutIamPolicy(): UseMutationResult<PolicyDetail, Error, PutPolicyVariables> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, name, document, description }) =>
      api.put<PolicyDetail>(iamPath(serverId, `policies/${encodeURIComponent(name)}`), {
        document,
        ...(description === undefined ? {} : { description }),
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteIamPolicy(): UseMutationResult<void, Error, PolicyRef> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, name }) =>
      api.delete<void>(iamPath(serverId, `policies/${encodeURIComponent(name)}`)),
    onSuccess: invalidate,
  });
}

export interface RestorePolicyVersionVariables extends PolicyRef {
  readonly versionId: string;
}

export function useRestoreIamPolicyVersion(): UseMutationResult<
  PolicyDetail,
  Error,
  RestorePolicyVersionVariables
> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, name, versionId }) =>
      api.post<PolicyDetail>(
        iamPath(
          serverId,
          `policies/${encodeURIComponent(name)}/versions/${encodeURIComponent(versionId)}/restore`,
        ),
      ),
    onSuccess: invalidate,
  });
}

export function useValidatePolicy(): UseMutationResult<
  ValidatePolicyResponse,
  Error,
  ValidatePolicyRequest
> {
  return useMutation({
    mutationFn: (body) => api.post<ValidatePolicyResponse>('/iam/policies/validate', body),
  });
}

export function useSimulatePolicy(): UseMutationResult<
  SimulatePolicyResponse,
  Error,
  SimulatePolicyRequest
> {
  return useMutation({
    mutationFn: (body) => api.post<SimulatePolicyResponse>('/iam/policies/simulate', body),
  });
}

/* ------------------------------ access keys ------------------------------ */

export function useAccessKeys(filters: ListAccessKeysQuery): UseQueryResult<AccessKeyList> {
  return useQuery({
    queryKey: queryKeys.iam.accessKeys(filters),
    queryFn: ({ signal }) => api.get<AccessKeyList>('/iam/access-keys', { ...filters }, signal),
  });
}

export interface CreateAccessKeyVariables extends CreateAccessKeyRequest {
  readonly serverId: string;
}

export function useCreateAccessKey(): UseMutationResult<
  CreatedKey,
  Error,
  CreateAccessKeyVariables
> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, ...body }) =>
      api.post<CreatedKey>(iamPath(serverId, 'access-keys'), body),
    onSuccess: invalidate,
  });
}

export interface AccessKeyRef {
  readonly serverId: string;
  readonly accessKeyId: string;
}

export interface UpdateAccessKeyVariables extends AccessKeyRef, UpdateAccessKeyRequest {}

export function useUpdateAccessKey(): UseMutationResult<
  AccessKey,
  Error,
  UpdateAccessKeyVariables
> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, accessKeyId, ...body }) =>
      api.patch<AccessKey>(
        iamPath(serverId, `access-keys/${encodeURIComponent(accessKeyId)}`),
        body,
      ),
    onSuccess: invalidate,
  });
}

export interface RotateAccessKeyVariables extends AccessKeyRef, RotateAccessKeyRequest {}

export function useRotateAccessKey(): UseMutationResult<
  CreatedKey,
  Error,
  RotateAccessKeyVariables
> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, accessKeyId, ...body }) =>
      api.post<CreatedKey>(
        iamPath(serverId, `access-keys/${encodeURIComponent(accessKeyId)}/rotate`),
        body,
      ),
    onSuccess: invalidate,
  });
}

/* --------------------------------- CSV ---------------------------------- */

/**
 * The server-rendered exports. They take the *same* filters as the lists, so what
 * comes out is what the operator is looking at — not the page they happen to be
 * on, which is what building the file in the browser would give.
 */
export type IamUsersCsvFilters = Omit<ListIamUsersQuery, 'page' | 'pageSize'>;
export type AccessKeysCsvFilters = Omit<ListAccessKeysQuery, 'page' | 'pageSize'>;

export function fetchIamUsersCsv(filters: IamUsersCsvFilters): Promise<Blob> {
  return api.blob('/iam/users/export.csv', { ...filters });
}

export function fetchAccessKeysCsv(filters: AccessKeysCsvFilters): Promise<Blob> {
  return api.blob('/iam/access-keys/export.csv', { ...filters });
}

export function useDeleteAccessKey(): UseMutationResult<void, Error, AccessKeyRef> {
  const invalidate = useIamInvalidation();
  return useMutation({
    mutationFn: ({ serverId, accessKeyId }) =>
      api.delete<void>(iamPath(serverId, `access-keys/${encodeURIComponent(accessKeyId)}`)),
    onSuccess: invalidate,
  });
}
