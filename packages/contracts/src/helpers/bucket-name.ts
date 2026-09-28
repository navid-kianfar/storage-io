/**
 * S3 bucket-name validation, shared by the API (before it calls a provider) and
 * the web app (inline form feedback), so both reject the same names for the same
 * reason.
 *
 * The rules are AWS's general-purpose bucket rules, which MinIO, Ceph RGW,
 * SeaweedFS and Garage all follow.
 */

export const BUCKET_NAME_MIN_LENGTH = 3;
export const BUCKET_NAME_MAX_LENGTH = 63;

export type BucketNameProblem =
  | 'too-short'
  | 'too-long'
  | 'invalid-characters'
  | 'must-start-and-end-alphanumeric'
  | 'consecutive-dots'
  | 'dash-adjacent-dot'
  | 'ip-address'
  | 'reserved-prefix'
  | 'reserved-suffix';

export interface BucketNameResult {
  readonly valid: boolean;
  readonly problem: BucketNameProblem | null;
  readonly message: string | null;
}

const MESSAGES: Readonly<Record<BucketNameProblem, string>> = {
  'too-short': `Must be at least ${String(BUCKET_NAME_MIN_LENGTH)} characters.`,
  'too-long': `Must be at most ${String(BUCKET_NAME_MAX_LENGTH)} characters.`,
  'invalid-characters': 'Only lowercase letters, digits, dots and dashes are allowed.',
  'must-start-and-end-alphanumeric': 'Must start and end with a lowercase letter or a digit.',
  'consecutive-dots': 'Must not contain two dots in a row.',
  'dash-adjacent-dot': 'A dash must not sit next to a dot.',
  'ip-address': 'Must not be formatted as an IPv4 address.',
  'reserved-prefix': 'Must not start with "xn--", "sthree-" or "amzn-s3-demo-".',
  'reserved-suffix': 'Must not end with "-s3alias" or "--ol-s3".',
};

const ALLOWED_CHARACTERS = /^[a-z0-9.-]+$/;
const ALPHANUMERIC = /^[a-z0-9]$/;
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const RESERVED_PREFIXES = ['xn--', 'sthree-', 'amzn-s3-demo-'] as const;
const RESERVED_SUFFIXES = ['-s3alias', '--ol-s3'] as const;

const fail = (problem: BucketNameProblem): BucketNameResult => ({
  valid: false,
  problem,
  message: MESSAGES[problem],
});

const OK: BucketNameResult = { valid: true, problem: null, message: null };

export function isValidBucketName(name: string): BucketNameResult {
  if (name.length < BUCKET_NAME_MIN_LENGTH) return fail('too-short');
  if (name.length > BUCKET_NAME_MAX_LENGTH) return fail('too-long');
  if (!ALLOWED_CHARACTERS.test(name)) return fail('invalid-characters');

  const first = name.slice(0, 1);
  const last = name.slice(-1);
  if (!ALPHANUMERIC.test(first) || !ALPHANUMERIC.test(last)) {
    return fail('must-start-and-end-alphanumeric');
  }

  if (name.includes('..')) return fail('consecutive-dots');
  if (name.includes('.-') || name.includes('-.')) return fail('dash-adjacent-dot');
  if (IPV4.test(name)) return fail('ip-address');

  const hasReservedPrefix = RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
  if (hasReservedPrefix) return fail('reserved-prefix');

  const hasReservedSuffix = RESERVED_SUFFIXES.some((suffix) => name.endsWith(suffix));
  if (hasReservedSuffix) return fail('reserved-suffix');

  return OK;
}
