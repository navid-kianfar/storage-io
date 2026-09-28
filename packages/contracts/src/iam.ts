import { z } from 'zod';
import {
  isoDateTime,
  jsonObject,
  listOf,
  paginationQuerySchema,
  problemFieldErrorSchema,
  providerSchema,
} from './common.js';
import { POLICY_DECISIONS } from './helpers/policy.js';

/**
 * An aggregated list spans every server whose driver supports the resource.
 * Servers that failed are named rather than silently dropped.
 */
export const unavailableServerSchema = z.object({
  serverId: z.string(),
  message: z.string(),
});
export type UnavailableServer = z.infer<typeof unavailableServerSchema>;

export const aggregatedListOf = <T extends z.ZodType>(item: T) =>
  listOf(item).extend({ unavailable: z.array(unavailableServerSchema) });

/* ------------------------------- users ---------------------------- */

export const S3_USER_STATUSES = ['enabled', 'disabled', 'unknown'] as const;
export const s3UserStatusSchema = z.enum(S3_USER_STATUSES);
export type S3UserStatus = z.infer<typeof s3UserStatusSchema>;

export const s3UserSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  provider: providerSchema,
  name: z.string(),
  status: s3UserStatusSchema,
  policies: z.array(z.string()),
  groups: z.array(z.string()),
  accessKeyCount: z.number().int().min(0),
  createdAt: isoDateTime.nullable(),
  lastActivityAt: isoDateTime.nullable(),
});
export type S3User = z.infer<typeof s3UserSchema>;

/**
 * `page`/`pageSize` come from `paginationQuerySchema` and default rather than
 * being required, so `GET /iam/users` with no query is still valid — docs/API.md
 * documents both on this endpoint.
 */
export const listIamUsersQuerySchema = paginationQuerySchema.extend({
  serverId: z.string().optional(),
  q: z.string().max(200).optional(),
  status: s3UserStatusSchema.optional(),
});
export type ListIamUsersQuery = z.infer<typeof listIamUsersQuerySchema>;

export const createS3UserRequestSchema = z.object({
  name: z.string().min(1).max(128),
  /** MinIO requires a secret; the AWS-style drivers ignore it. */
  secret: z.string().min(8).max(1024).nullable(),
  policies: z.array(z.string()),
  groups: z.array(z.string()),
  createAccessKey: z.boolean(),
});
export type CreateS3UserRequest = z.infer<typeof createS3UserRequestSchema>;

export const updateS3UserRequestSchema = z.object({ status: z.enum(['enabled', 'disabled']) });
export type UpdateS3UserRequest = z.infer<typeof updateS3UserRequestSchema>;

export const setUserPoliciesRequestSchema = z.object({ policies: z.array(z.string()) });
export type SetUserPoliciesRequest = z.infer<typeof setUserPoliciesRequestSchema>;

export const setUserGroupsRequestSchema = z.object({ groups: z.array(z.string()) });
export type SetUserGroupsRequest = z.infer<typeof setUserGroupsRequestSchema>;

/* ---------------------------- access keys ------------------------- */

export const ACCESS_KEY_STATUSES = ['active', 'disabled', 'expired'] as const;
export const accessKeyStatusSchema = z.enum(ACCESS_KEY_STATUSES);
export type AccessKeyStatus = z.infer<typeof accessKeyStatusSchema>;

export const accessKeySchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  provider: providerSchema,
  accessKeyId: z.string(),
  userName: z.string(),
  name: z.string().nullable(),
  status: accessKeyStatusSchema,
  /** True when a session policy narrows the key below its user's permissions. */
  restricted: z.boolean(),
  createdAt: isoDateTime.nullable(),
  expiresAt: isoDateTime.nullable(),
  lastUsedAt: isoDateTime.nullable(),
  rotation: z.object({ replacedBy: z.string(), disableAt: isoDateTime }).nullable(),
});
export type AccessKey = z.infer<typeof accessKeySchema>;

export const createdKeySchema = z.object({
  accessKey: accessKeySchema,
  /** Shown once. */
  secretAccessKey: z.string(),
  endpoint: z.string(),
  region: z.string(),
});
export type CreatedKey = z.infer<typeof createdKeySchema>;

export const s3UserDetailSchema = s3UserSchema.extend({
  accessKeys: z.array(accessKeySchema),
  inheritedPolicies: z.array(z.object({ policy: z.string(), fromGroup: z.string() })),
});
export type S3UserDetail = z.infer<typeof s3UserDetailSchema>;

export const s3UserListSchema = aggregatedListOf(s3UserSchema);
export type S3UserList = z.infer<typeof s3UserListSchema>;

export const createS3UserResponseSchema = z.object({
  user: s3UserSchema,
  accessKey: createdKeySchema.nullable(),
});
export type CreateS3UserResponse = z.infer<typeof createS3UserResponseSchema>;

/**
 * What `status=expiring` means, and the window the expiring-key notification
 * uses. Shared so the UI's "expires in N days" wording cannot drift from the
 * filter the API applies.
 */
export const ACCESS_KEY_EXPIRING_DAYS = 7;

export const ACCESS_KEY_FILTERS = ['active', 'expiring', 'disabled', 'expired'] as const;
export const accessKeyFilterSchema = z.enum(ACCESS_KEY_FILTERS);
export type AccessKeyFilter = z.infer<typeof accessKeyFilterSchema>;

export const listAccessKeysQuerySchema = paginationQuerySchema.extend({
  serverId: z.string().optional(),
  userName: z.string().optional(),
  status: accessKeyFilterSchema.optional(),
  q: z.string().max(200).optional(),
});
export type ListAccessKeysQuery = z.infer<typeof listAccessKeysQuerySchema>;

export const accessKeyListSchema = aggregatedListOf(accessKeySchema).extend({
  counts: z.object({
    all: z.number().int().min(0),
    active: z.number().int().min(0),
    expiring: z.number().int().min(0),
    disabled: z.number().int().min(0),
  }),
});
export type AccessKeyList = z.infer<typeof accessKeyListSchema>;

export const createAccessKeyRequestSchema = z.object({
  userName: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  expiresAt: isoDateTime.nullable(),
  /** Session policy; `null` = the user's own permissions. */
  policy: jsonObject.nullable(),
});
export type CreateAccessKeyRequest = z.infer<typeof createAccessKeyRequestSchema>;

export const updateAccessKeyRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    expiresAt: isoDateTime.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field is required' });
export type UpdateAccessKeyRequest = z.infer<typeof updateAccessKeyRequestSchema>;

export const rotateAccessKeyRequestSchema = z.object({
  /** 0 disables the old key immediately. */
  graceSeconds: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 3600),
  expiresAt: isoDateTime.nullable(),
});
export type RotateAccessKeyRequest = z.infer<typeof rotateAccessKeyRequestSchema>;

/* ------------------------------ groups ---------------------------- */

export const s3GroupSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  name: z.string(),
  members: z.array(z.string()),
  policies: z.array(z.string()),
  status: z.enum(['enabled', 'disabled']),
});
export type S3Group = z.infer<typeof s3GroupSchema>;

export const s3GroupListSchema = aggregatedListOf(s3GroupSchema);
export type S3GroupList = z.infer<typeof s3GroupListSchema>;

export const listIamGroupsQuerySchema = z.object({
  serverId: z.string().optional(),
  q: z.string().max(200).optional(),
});
export type ListIamGroupsQuery = z.infer<typeof listIamGroupsQuerySchema>;

export const upsertS3GroupRequestSchema = z.object({
  name: z.string().min(1).max(128),
  members: z.array(z.string()),
  policies: z.array(z.string()),
  status: z.enum(['enabled', 'disabled']).optional(),
});
export type UpsertS3GroupRequest = z.infer<typeof upsertS3GroupRequestSchema>;

/* ----------------------------- policies --------------------------- */

export const policySummarySchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  name: z.string(),
  builtIn: z.boolean(),
  description: z.string().nullable(),
  attachedCount: z.number().int().min(0),
  updatedAt: isoDateTime.nullable(),
});
export type PolicySummary = z.infer<typeof policySummarySchema>;

export const policyDetailSchema = policySummarySchema.extend({
  document: jsonObject,
  attachedTo: z.object({ users: z.array(z.string()), groups: z.array(z.string()) }),
});
export type PolicyDetail = z.infer<typeof policyDetailSchema>;

export const policyListSchema = aggregatedListOf(policySummarySchema);
export type PolicyList = z.infer<typeof policyListSchema>;

export const listIamPoliciesQuerySchema = listIamGroupsQuerySchema;
export type ListIamPoliciesQuery = z.infer<typeof listIamPoliciesQuerySchema>;

export const putPolicyRequestSchema = z.object({
  document: jsonObject,
  description: z.string().max(500).optional(),
});
export type PutPolicyRequest = z.infer<typeof putPolicyRequestSchema>;

export const validatePolicyRequestSchema = z.object({ document: jsonObject });
export type ValidatePolicyRequest = z.infer<typeof validatePolicyRequestSchema>;

export const validatePolicyResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(problemFieldErrorSchema),
  warnings: z.array(z.string()),
});
export type ValidatePolicyResponse = z.infer<typeof validatePolicyResponseSchema>;

export const policyDecisionSchema = z.enum(POLICY_DECISIONS);
export type PolicyDecisionValue = z.infer<typeof policyDecisionSchema>;

export const simulatePolicyRequestSchema = z.object({
  document: jsonObject,
  action: z.string().min(1).max(200),
  resource: z.string().min(1).max(2048),
  context: z.record(z.string(), z.string()).optional(),
});
export type SimulatePolicyRequest = z.infer<typeof simulatePolicyRequestSchema>;

export const simulatePolicyResponseSchema = z.object({
  decision: policyDecisionSchema,
  statementSid: z.string().nullable(),
  statementIndex: z.number().int().min(0).nullable(),
});
export type SimulatePolicyResponse = z.infer<typeof simulatePolicyResponseSchema>;

/* -------------------------- policy versions ----------------------- */

/**
 * Every `PUT /servers/:sid/iam/policies/:name` made through storage-io snapshots
 * the previous document in the app database, so a bad edit can be rolled back
 * even on providers that keep no history of their own.
 */
export const policyVersionSchema = z.object({
  id: z.string(),
  createdAt: isoDateTime,
  document: jsonObject,
  note: z.string().nullable(),
});
export type PolicyVersion = z.infer<typeof policyVersionSchema>;

export const policyVersionListSchema = z.object({ items: z.array(policyVersionSchema) });
export type PolicyVersionList = z.infer<typeof policyVersionListSchema>;

/** Column order of `/iam/users/export.csv`. */
export const IAM_USER_CSV_COLUMNS = [
  'serverName',
  'provider',
  'name',
  'status',
  'policies',
  'groups',
  'accessKeyCount',
  'createdAt',
  'lastActivityAt',
] as const;

/** Column order of `/iam/access-keys/export.csv`. */
export const ACCESS_KEY_CSV_COLUMNS = [
  'serverName',
  'provider',
  'accessKeyId',
  'userName',
  'name',
  'status',
  'restricted',
  'createdAt',
  'expiresAt',
  'lastUsedAt',
] as const;
