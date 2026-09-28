import {
  HEALTH_INTERVAL_DEFAULT_SEC,
  PROVIDER_IAM_DRIVERS,
  SERVER_NAME_PATTERN,
  SERVER_OPTION_DEFAULTS,
  createServerRequestSchema,
  type CreateServerRequest,
  type Provider,
  type Server,
  type UpdateServerRequest,
} from '@storage-io/contracts';
import type { UseFormSetError } from 'react-hook-form';
import { z } from 'zod';
import { isApiError } from '@/lib/api/errors';

/**
 * The form behind the shared connection form. It is the contract's
 * `createServerRequest` flattened by one level — react-hook-form addresses a
 * nested path fine, but a flat shape keeps `applyFieldErrors` and the advanced
 * disclosure readable — plus the two fields the contract does not have:
 * `caPem` arrives as the text of a pasted or dropped PEM file, and
 * `secretAccessKey` is optional when editing (omitting it keeps the stored one).
 */

export const HEALTH_INTERVAL_CHOICES = [30, 60, 300, 900, 3600] as const;

/** The slug length the contract's own `serverNameSchema` enforces. */
const SERVER_NAME_MAX_LENGTH = 63;

const MAX_CA_PEM_LENGTH = 32_768;

/**
 * Messages are i18n keys, not sentences: `ConnectionForm` runs each one through
 * `t()` with the raw string as the fallback, so a message that comes from the
 * contract's own schemas still reaches the operator.
 */
export const connectionFormSchema = z.object({
  provider: createServerRequestSchema.shape.provider,
  name: z
    .string()
    .min(1, 'servers.validation.nameRequired')
    .max(SERVER_NAME_MAX_LENGTH, 'servers.validation.nameTooLong')
    .regex(SERVER_NAME_PATTERN, 'servers.validation.nameFormat'),
  endpoint: z.url({ protocol: /^https?$/, error: 'servers.validation.endpointInvalid' }),
  region: z.string().min(1, 'servers.validation.regionRequired').max(64),
  accessKeyId: z.string().min(1, 'servers.validation.accessKeyIdRequired').max(256),
  /** Empty means "keep the stored secret"; the caller decides whether that is allowed. */
  secretAccessKey: z.string().max(1024),
  adminToken: z.string().max(4096),
  pathStyle: z.boolean(),
  tlsVerify: z.boolean(),
  caPem: z.string().max(MAX_CA_PEM_LENGTH),
  adminEndpoint: z.string().max(2048),
  iamEndpoint: z.string().max(2048),
  healthIntervalSec: z.number().int(),
});

export type ConnectionFormValues = z.infer<typeof connectionFormSchema>;

/** Every path `applyFieldErrors` can land on, in this form's own notation. */
export const CONNECTION_FIELD_PATHS: readonly string[] = [
  'provider',
  'name',
  'endpoint',
  'region',
  'accessKeyId',
  'secretAccessKey',
  'adminToken',
  'pathStyle',
  'tlsVerify',
  'caPem',
  'adminEndpoint',
  'iamEndpoint',
  'healthIntervalSec',
];

/**
 * Moves a 422's `errors[]` onto the form. The API nests the connection options
 * one level deeper than this form does (`options.adminEndpoint`), so the prefix is
 * stripped before matching; a path this form has no field for is left for the
 * caller to report as a toast.
 *
 * Returns true when at least one error landed on a field, which is the caller's
 * signal that the operator can already see what is wrong.
 */
export function applyConnectionFieldErrors(
  error: unknown,
  setError: UseFormSetError<ConnectionFormValues>,
): boolean {
  if (!isApiError(error) || error.fieldErrors.length === 0) return false;
  let matched = false;
  for (const fieldError of error.fieldErrors) {
    const path = fieldError.path.startsWith('options.')
      ? fieldError.path.slice('options.'.length)
      : fieldError.path;
    if (!CONNECTION_FIELD_PATHS.includes(path)) continue;
    setError(path as keyof ConnectionFormValues, {
      type: 'server',
      message: fieldError.message,
    });
    matched = true;
  }
  return matched;
}

export function emptyConnectionValues(provider: Provider): ConnectionFormValues {
  return {
    provider,
    name: '',
    endpoint: '',
    region: defaultRegionFor(provider),
    accessKeyId: '',
    secretAccessKey: '',
    adminToken: '',
    pathStyle: provider !== 'aws' && provider !== 'r2',
    tlsVerify: SERVER_OPTION_DEFAULTS.tlsVerify,
    caPem: '',
    adminEndpoint: '',
    iamEndpoint: '',
    healthIntervalSec: HEALTH_INTERVAL_DEFAULT_SEC,
  };
}

export function connectionValuesOf(server: Server): ConnectionFormValues {
  return {
    provider: server.provider,
    name: server.name,
    endpoint: server.endpoint,
    region: server.region,
    accessKeyId: server.accessKeyId,
    // Never prefilled: the API only ever returns the masked form.
    secretAccessKey: '',
    adminToken: '',
    pathStyle: server.options.pathStyle,
    tlsVerify: server.options.tlsVerify,
    caPem: server.options.caPem ?? '',
    adminEndpoint: server.options.adminEndpoint ?? '',
    iamEndpoint: server.options.iamEndpoint ?? '',
    healthIntervalSec: server.options.healthIntervalSec,
  };
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** The `CreateServer` body every endpoint that takes a connection expects. */
export function toCreateServerRequest(values: ConnectionFormValues): CreateServerRequest {
  const adminToken = blankToNull(values.adminToken);
  return {
    name: values.name,
    provider: values.provider,
    endpoint: values.endpoint.trim(),
    region: values.region.trim(),
    accessKeyId: values.accessKeyId.trim(),
    secretAccessKey: values.secretAccessKey,
    options: {
      pathStyle: values.pathStyle,
      tlsVerify: values.tlsVerify,
      caPem: blankToNull(values.caPem),
      adminEndpoint: blankToNull(values.adminEndpoint),
      iamEndpoint: blankToNull(values.iamEndpoint),
      healthIntervalSec: values.healthIntervalSec,
      ...(adminToken === null ? {} : { adminToken }),
    },
  };
}

/**
 * PATCH keeps the stored secret when the field is left empty, which is the whole
 * reason the edit form does not prefill it.
 */
export function toUpdateServerRequest(values: ConnectionFormValues): UpdateServerRequest {
  const { name, provider, endpoint, region, accessKeyId, options } =
    toCreateServerRequest(values);
  const base = { name, provider, endpoint, region, accessKeyId, options };
  if (values.secretAccessKey.length === 0) return base;
  return { ...base, secretAccessKey: values.secretAccessKey };
}

/** Garage authenticates its admin API with a bearer token rather than a key pair. */
export function providerUsesAdminToken(provider: Provider): boolean {
  return provider === 'garage';
}

/** Whether an admin/IAM endpoint is worth asking for at all. */
export function providerUsesAdminEndpoint(provider: Provider): boolean {
  return PROVIDER_IAM_DRIVERS[provider] !== 'none';
}

function defaultRegionFor(provider: Provider): string {
  switch (provider) {
    case 'aws':
      return 'eu-central-1';
    case 'r2':
      return 'auto';
    case 'wasabi':
      return 'us-east-1';
    case 'minio':
    case 'seaweedfs':
    case 'ceph':
    case 'garage':
    case 'generic':
      return 'us-east-1';
  }
}
