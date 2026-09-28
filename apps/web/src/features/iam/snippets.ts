import type { CreatedKey, Provider } from '@storage-io/contracts';

/**
 * The copy-paste snippets shown once, beside a new secret.
 *
 * They are generated from the key the server just returned — its endpoint, its
 * region and the alias the operator will actually type — because a snippet with a
 * placeholder endpoint is a snippet that gets pasted and then fails at 2 a.m. The
 * profile/alias name is the server's own slug for the same reason.
 *
 * Nothing here is stored: the secret lives in this object for the lifetime of the
 * dialog and is never written to `localStorage`, a query cache or a log.
 */

export const SNIPPET_KINDS = ['env', 'awscli', 'rclone', 'mc'] as const;
export type SnippetKind = (typeof SNIPPET_KINDS)[number];

/** rclone's `provider =` value, which is not the same word as ours. */
const RCLONE_PROVIDERS: Readonly<Record<Provider, string>> = {
  minio: 'Minio',
  seaweedfs: 'Other',
  aws: 'AWS',
  ceph: 'Ceph',
  garage: 'Other',
  r2: 'Cloudflare',
  wasabi: 'Wasabi',
  generic: 'Other',
};

export interface SnippetInput {
  readonly created: CreatedKey;
  /** The alias/profile name: the server's slug. */
  readonly alias: string;
}

export function buildSnippet(kind: SnippetKind, { created, alias }: SnippetInput): string {
  const id = created.accessKey.accessKeyId;
  const secret = created.secretAccessKey;
  const endpoint = created.endpoint;
  const region = created.region;

  switch (kind) {
    case 'env':
      return [
        `AWS_ACCESS_KEY_ID=${id}`,
        `AWS_SECRET_ACCESS_KEY=${secret}`,
        `AWS_ENDPOINT_URL=${endpoint}`,
        `AWS_REGION=${region}`,
      ].join('\n');

    case 'awscli':
      return [
        `aws configure set aws_access_key_id ${id} --profile ${alias}`,
        `aws configure set aws_secret_access_key ${secret} --profile ${alias}`,
        `aws configure set region ${region} --profile ${alias}`,
        `aws --profile ${alias} --endpoint-url ${endpoint} s3 ls`,
      ].join('\n');

    case 'rclone':
      return [
        `[${alias}]`,
        'type = s3',
        `provider = ${RCLONE_PROVIDERS[created.accessKey.provider]}`,
        'env_auth = false',
        `access_key_id = ${id}`,
        `secret_access_key = ${secret}`,
        `endpoint = ${endpoint}`,
        `region = ${region}`,
      ].join('\n');

    case 'mc':
      return `mc alias set ${alias} ${endpoint} ${id} ${secret}`;

    default:
      return exhausted(kind);
  }
}

function exhausted(kind: never): never {
  throw new Error(`Unhandled snippet kind: ${String(kind)}`);
}

/** The columns AWS's own `credentials.csv` uses, plus what our operator needs. */
export const CREDENTIALS_CSV_HEADERS = [
  'Access key ID',
  'Secret access key',
  'Endpoint',
  'Region',
  'User name',
  'Key name',
  'Expires at',
] as const;

export function credentialsCsvRow(created: CreatedKey): readonly string[] {
  return [
    created.accessKey.accessKeyId,
    created.secretAccessKey,
    created.endpoint,
    created.region,
    created.accessKey.userName,
    created.accessKey.name ?? '',
    created.accessKey.expiresAt ?? '',
  ];
}
