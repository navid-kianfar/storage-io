import type { ErrorCode } from '@storage-io/contracts';

/**
 * Translates an AWS SDK / provider failure into a contract error code and a
 * message that is safe to send across the trust boundary.
 *
 * Nothing from a provider reaches a client verbatim: a raw SDK message can
 * carry the endpoint host, a bucket path or an internal node name. The full
 * error is logged; the caller gets the mapped code and a sanitized sentence.
 */

export interface MappedProviderError {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string;
}

/** SDK error names that mean "the thing is not there". */
const NOT_FOUND_NAMES = new Set([
  'NoSuchBucket',
  'NoSuchKey',
  'NoSuchVersion',
  'NoSuchUpload',
  'NoSuchLifecycleConfiguration',
  'NoSuchCORSConfiguration',
  'NoSuchBucketPolicy',
  'NoSuchTagSet',
  'NoSuchReplicationConfiguration',
  'ReplicationConfigurationNotFoundError',
  'ObjectLockConfigurationNotFoundError',
  'ServerSideEncryptionConfigurationNotFoundError',
  'NotFound',
  'NoSuchEntity',
]);

const CONFLICT_NAMES = new Set([
  'BucketAlreadyExists',
  'BucketAlreadyOwnedByYou',
  'EntityAlreadyExists',
  'InvalidBucketState',
  'OperationAborted',
  'PreconditionFailed',
]);

const NOT_SUPPORTED_NAMES = new Set([
  'NotImplemented',
  'MethodNotAllowed',
  'InvalidRequest',
  'UnsupportedOperation',
]);

const CREDENTIAL_NAMES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'AccessDenied',
  'AccessDeniedException',
  'ExpiredToken',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
]);

/** Node/undici transport failures — the server is not answering at all. */
const OFFLINE_SYSCALL_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'TimeoutError',
  'RequestTimeout',
  'AbortError',
]);

/** TLS failures deserve their own message: the fix is a CA, not a restart. */
const TLS_ERROR_PREFIX = 'CERT_';
const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
]);

const MAX_DETAIL_LENGTH = 200;

const URL_LIKE = /\b(?:https?|s3):\/\/\S+/gi;
const ABSOLUTE_PATH = /(?:^|\s)\/(?:[\w.-]+\/)+[\w.-]*/g;
const IPV4_LIKE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g;

/**
 * Strips endpoints, IPs and filesystem paths, then truncates. What is left is
 * the provider's own wording about *what* went wrong, without saying where.
 */
export function sanitizeProviderMessage(message: string): string {
  const withoutLocations = message
    .replace(URL_LIKE, '[endpoint]')
    .replace(IPV4_LIKE, '[address]')
    .replace(ABSOLUTE_PATH, ' [path]')
    .replace(/\s+/g, ' ')
    .trim();

  if (withoutLocations.length <= MAX_DETAIL_LENGTH) return withoutLocations;
  return `${withoutLocations.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

interface ErrorShape {
  readonly name?: string;
  readonly code?: string;
  readonly message?: string;
  readonly cause?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

const shapeOf = (error: unknown): ErrorShape =>
  typeof error === 'object' && error !== null ? error : {};

/** Walks `cause` chains, because undici hides the syscall code one level down. */
function collectCodes(error: unknown, depth = 0): readonly string[] {
  if (depth > 4) return [];
  const shape = shapeOf(error);
  const own = [shape.name, shape.code].filter(
    (value): value is string => typeof value === 'string',
  );
  if (shape.cause === undefined) return own;
  return [...own, ...collectCodes(shape.cause, depth + 1)];
}

/**
 * `null` when the error is not a provider/transport failure at all, so the
 * caller can fall through to its generic handling instead of mislabelling a bug
 * in our own code as the provider's fault.
 */
export function mapProviderError(error: unknown): MappedProviderError | null {
  const shape = shapeOf(error);
  const codes = collectCodes(error);
  const httpStatus = shape.$metadata?.httpStatusCode;
  const rawMessage = typeof shape.message === 'string' ? shape.message : '';
  const detail = sanitizeProviderMessage(rawMessage);

  const hasTlsProblem = codes.some(
    (code) => code.startsWith(TLS_ERROR_PREFIX) || TLS_ERROR_CODES.has(code),
  );
  if (hasTlsProblem) {
    return {
      code: 'SERVER_OFFLINE',
      status: 503,
      detail: `TLS handshake failed: ${detail || 'certificate could not be verified'}. Check the CA certificate or turn TLS verification off for this server.`,
    };
  }

  const isOffline = codes.some((code) => OFFLINE_SYSCALL_CODES.has(code));
  if (isOffline) {
    return {
      code: 'SERVER_OFFLINE',
      status: 503,
      detail: 'The storage server did not respond.',
    };
  }

  const name = codes.find((code) => NOT_FOUND_NAMES.has(code));
  if (name !== undefined) {
    return {
      code: 'NOT_FOUND',
      status: 404,
      detail: detail || 'The requested resource does not exist.',
    };
  }

  if (codes.some((code) => CONFLICT_NAMES.has(code))) {
    return { code: 'CONFLICT', status: 409, detail: detail || 'The resource already exists.' };
  }

  if (codes.includes('BucketNotEmpty')) {
    return {
      code: 'BUCKET_NOT_EMPTY',
      status: 409,
      detail: 'The bucket still contains objects.',
    };
  }

  if (codes.some((code) => NOT_SUPPORTED_NAMES.has(code))) {
    return {
      code: 'NOT_SUPPORTED',
      status: 409,
      detail: detail || 'The storage server does not support this operation.',
    };
  }

  if (codes.some((code) => CREDENTIAL_NAMES.has(code))) {
    return {
      code: 'PROVIDER_ERROR',
      status: 502,
      detail: "The storage server rejected storage-io's credentials.",
    };
  }

  // Anything that reached the provider and came back with an HTTP status is
  // still a provider error, even when the name is one we have never seen.
  if (httpStatus !== undefined) {
    return {
      code: 'PROVIDER_ERROR',
      status: 502,
      detail: detail || `The storage server returned HTTP ${httpStatus}.`,
    };
  }

  return null;
}
