import type { PolicyDocument, PolicyStatement } from '@storage-io/contracts';

/**
 * The starting documents the "New policy" menu offers.
 *
 * They are written against one bucket because that is what an operator is almost
 * always granting, and because a template that says `arn:aws:s3:::*` teaches the
 * wrong habit the first time it is used. `Version` is always the 2012-10-17
 * language: the validator warns when it is missing, and every provider assumes the
 * oldest language without it.
 */

export const POLICY_TEMPLATES = ['read-only', 'read-write', 'upload-only', 'public-read', 'blank'] as const;
export type PolicyTemplate = (typeof POLICY_TEMPLATES)[number];

export const POLICY_VERSION = '2012-10-17';

/** `bucket` is the placeholder the dialog substitutes before the document is saved. */
export const BUCKET_PLACEHOLDER = 'bucket-name';

function bucketArns(bucket: string): readonly string[] {
  return [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`];
}

function documentOf(statements: readonly PolicyStatement[]): PolicyDocument {
  return { Version: POLICY_VERSION, Statement: statements };
}

export function templateDocument(template: PolicyTemplate, bucket: string): PolicyDocument {
  const arns = bucketArns(bucket);
  const objectArn = `arn:aws:s3:::${bucket}/*`;

  switch (template) {
    case 'read-only':
      return documentOf([
        {
          Sid: 'ReadBucket',
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:GetBucketLocation', 's3:ListBucket'],
          Resource: arns,
        },
      ]);

    case 'read-write':
      return documentOf([
        {
          Sid: 'ReadWriteBucket',
          Effect: 'Allow',
          Action: [
            's3:GetObject',
            's3:PutObject',
            's3:DeleteObject',
            's3:ListBucket',
            's3:AbortMultipartUpload',
            's3:ListBucketMultipartUploads',
          ],
          Resource: arns,
        },
      ]);

    case 'upload-only':
      return documentOf([
        {
          Sid: 'UploadOnly',
          Effect: 'Allow',
          Action: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListBucketMultipartUploads'],
          Resource: arns,
        },
        {
          Sid: 'DenyRead',
          Effect: 'Deny',
          Action: ['s3:GetObject'],
          Resource: [objectArn],
        },
      ]);

    case 'public-read':
      return documentOf([
        {
          Sid: 'PublicRead',
          Effect: 'Allow',
          Action: ['s3:GetObject'],
          Resource: [objectArn],
        },
      ]);

    case 'blank':
      return documentOf([
        { Sid: 'Statement1', Effect: 'Allow', Action: [], Resource: [] },
      ]);

    default:
      return exhausted(template);
  }
}

function exhausted(template: never): never {
  throw new Error(`Unhandled policy template: ${String(template)}`);
}

/* ------------------------- reading a document ---------------------------- */

/** The statements of a document, always as an array even when the JSON had one. */
export function statementsOf(document: unknown): readonly PolicyStatement[] {
  if (typeof document !== 'object' || document === null) return [];
  const raw: PolicyStatement | readonly PolicyStatement[] | undefined = (document as PolicyDocument)
    .Statement;
  if (raw === undefined) return [];
  // `Array.isArray` widens a readonly tuple to `any[]`, so the branch is decided by
  // the predicate and the value is used at its declared type.
  return isStatementList(raw) ? raw : [raw];
}

function isStatementList(
  value: PolicyStatement | readonly PolicyStatement[],
): value is readonly PolicyStatement[] {
  return Array.isArray(value);
}

export function withStatements(
  document: unknown,
  statements: readonly PolicyStatement[],
): PolicyDocument {
  const base = typeof document === 'object' && document !== null ? (document as PolicyDocument) : {};
  return { ...base, Version: base.Version ?? POLICY_VERSION, Statement: [...statements] };
}

/** A string field that may be a single value or a list, as an array. */
export function asList(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : [...value];
}

/**
 * The actions the combobox offers. Not exhaustive and deliberately not presented
 * as such — the field accepts anything, because every provider has its own
 * namespace (MinIO's `admin:*`, Ceph's `sts:*`) and a closed list would refuse a
 * valid policy.
 */
export const COMMON_S3_ACTIONS = [
  's3:*',
  's3:GetObject',
  's3:GetObjectVersion',
  's3:PutObject',
  's3:DeleteObject',
  's3:DeleteObjectVersion',
  's3:ListBucket',
  's3:ListBucketVersions',
  's3:ListBucketMultipartUploads',
  's3:AbortMultipartUpload',
  's3:GetBucketLocation',
  's3:GetBucketPolicy',
  's3:PutBucketPolicy',
  's3:GetBucketTagging',
  's3:PutBucketTagging',
  's3:GetObjectTagging',
  's3:PutObjectTagging',
  's3:GetObjectRetention',
  's3:PutObjectRetention',
  's3:GetObjectLegalHold',
  's3:PutObjectLegalHold',
  's3:GetLifecycleConfiguration',
  's3:PutLifecycleConfiguration',
  'admin:*',
  'admin:ServerInfo',
  'admin:Prometheus',
] as const;

/** Resource suggestions built from the buckets the operator actually has. */
export function resourceSuggestions(buckets: readonly string[]): readonly string[] {
  const suggestions = ['arn:aws:s3:::*', 'arn:aws:s3:::*/*'];
  for (const bucket of buckets) {
    suggestions.push(`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`);
  }
  return suggestions;
}
