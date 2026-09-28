import type { BucketAccess, JsonObject } from '@storage-io/contracts';

/**
 * The two access presets, and the reverse mapping that decides which preset (if
 * any) an existing bucket policy corresponds to.
 *
 * Pure functions with no dependencies, because both the buckets module (writing a
 * preset) and the inventory refresher (classifying what it finds) need them, and
 * a bucket that shows as `public-read` in the list but `custom` on its settings
 * page would be the same bug in two places.
 *
 * `custom` is never *requested* — the contract only lets a client ask for
 * `private` or `public-read`; it is what the classifier reports for a policy that
 * is not one of the presets.
 */

const POLICY_VERSION = '2012-10-17';
const ANONYMOUS_PRINCIPAL = '*';
const ARN_PREFIX = 'arn:aws:s3:::';

const ACTION_GET_OBJECT = 's3:GetObject';
const ACTION_GET_OBJECT_VERSION = 's3:GetObjectVersion';
const ACTION_LIST_BUCKET = 's3:ListBucket';

/** Actions a `public-read` bucket may grant anonymously, and nothing else. */
const PUBLIC_READ_ACTIONS: readonly string[] = [
  ACTION_GET_OBJECT,
  ACTION_GET_OBJECT_VERSION,
  ACTION_LIST_BUCKET,
];

export const bucketArn = (bucket: string): string => `${ARN_PREFIX}${bucket}`;
export const objectsArn = (bucket: string): string => `${ARN_PREFIX}${bucket}/*`;

/**
 * The canonical policy storage-io writes for `public-read`: anonymous object
 * reads plus a listable bucket, which is what the S3 `public-read` canned ACL
 * grants. Two statements rather than one, because the object actions and the
 * bucket action apply to different ARNs.
 */
export function publicReadPolicy(bucket: string): JsonObject {
  return {
    Version: POLICY_VERSION,
    Statement: [
      {
        Sid: 'StorageIoPublicReadObjects',
        Effect: 'Allow',
        Principal: { AWS: [ANONYMOUS_PRINCIPAL] },
        Action: [ACTION_GET_OBJECT],
        Resource: [objectsArn(bucket)],
      },
      {
        Sid: 'StorageIoPublicListBucket',
        Effect: 'Allow',
        Principal: { AWS: [ANONYMOUS_PRINCIPAL] },
        Action: [ACTION_LIST_BUCKET],
        Resource: [bucketArn(bucket)],
      },
    ],
  };
}

/** `null` is the policy for `private`: storage-io deletes the policy instead. */
export function policyForAccess(
  access: 'private' | 'public-read',
  bucket: string,
): JsonObject | null {
  return access === 'private' ? null : publicReadPolicy(bucket);
}

/**
 * Which preset a policy represents.
 *
 * Deliberately generous about *shape* and strict about *effect*: any policy whose
 * every statement is an anonymous Allow limited to this bucket's read actions is
 * `public-read`, however it is spelled. One extra action, one other principal, one
 * `Deny`, one condition — and it is `custom`, because storage-io must not present
 * a policy it does not fully understand as a preset it could overwrite.
 */
export function accessFromPolicy(policy: unknown, bucket: string): BucketAccess {
  if (policy === null || policy === undefined) return 'private';

  const statements = statementsOf(policy);
  if (statements === null) return 'custom';
  if (statements.length === 0) return 'private';

  const allowedResources = new Set([bucketArn(bucket), objectsArn(bucket)]);
  let grantsObjectRead = false;

  for (const statement of statements) {
    if (!isAnonymousAllow(statement)) return 'custom';
    if (statement['Condition'] !== undefined) return 'custom';
    if (statement['NotAction'] !== undefined || statement['NotResource'] !== undefined) {
      return 'custom';
    }

    const actions = stringList(statement['Action']);
    const resources = stringList(statement['Resource']);
    if (actions.length === 0 || resources.length === 0) return 'custom';
    if (!actions.every((action) => PUBLIC_READ_ACTIONS.includes(action))) return 'custom';
    if (!resources.every((resource) => allowedResources.has(resource))) return 'custom';

    if (actions.includes(ACTION_GET_OBJECT) && resources.includes(objectsArn(bucket))) {
      grantsObjectRead = true;
    }
  }

  return grantsObjectRead ? 'public-read' : 'custom';
}

/* ------------------------------ helpers --------------------------- */

type Statement = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `null` when the document is not a policy at all — the caller reports `custom`. */
function statementsOf(policy: unknown): readonly Statement[] | null {
  if (!isRecord(policy)) return null;
  const raw = policy['Statement'];
  if (raw === undefined) return [];
  if (isRecord(raw)) return [raw];
  if (!Array.isArray(raw)) return null;
  if (!raw.every(isRecord)) return null;
  return raw;
}

function stringList(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** `"*"`, `{ AWS: "*" }` and `{ AWS: ["*"] }` all mean "anyone". */
function isAnonymousPrincipal(principal: unknown): boolean {
  if (principal === ANONYMOUS_PRINCIPAL) return true;
  if (!isRecord(principal)) return false;
  const aws = stringList(principal['AWS']);
  return aws.length > 0 && aws.every((entry) => entry === ANONYMOUS_PRINCIPAL);
}

function isAnonymousAllow(statement: Statement): boolean {
  const effect = statement['Effect'];
  if (typeof effect !== 'string' || effect.toLowerCase() !== 'allow') return false;
  if (statement['NotPrincipal'] !== undefined) return false;
  return isAnonymousPrincipal(statement['Principal']);
}
