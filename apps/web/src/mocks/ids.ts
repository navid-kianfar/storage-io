/**
 * Opaque ids for the mock API.
 *
 * The real API mints a random UUID once per `(serverId, kind, name)` and keeps it
 * in a registry table, so the same entity always resolves to the same id. The mock
 * has no table, so it derives the UUID from that same tuple instead: same inputs,
 * same id, across a page reload and across handler modules — which is the property
 * the ID routes depend on.
 *
 * It is deliberately UUID-shaped and carries no readable part of the name: a bug
 * where the web app parses an entity name back out of a route param has to fail
 * here exactly as it would against the real API.
 */

const FNV_OFFSET_BASIS = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;
const HEX_RADIX = 16;
const UUID_HEX_LENGTH = 32;
const UUID_VERSION_INDEX = 12;
const UUID_VARIANT_INDEX = 16;

function fnv1a(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function hexBlock(seed: string): string {
  return fnv1a(seed).toString(HEX_RADIX).padStart(8, '0');
}

/** A stable, opaque, UUID-shaped id for any key. */
export function mockId(kind: string, ...parts: readonly string[]): string {
  const key = [kind, ...parts].join('\u0000');
  let hex = '';
  for (let round = 0; hex.length < UUID_HEX_LENGTH; round += 1) {
    hex += hexBlock(`${round}:${key}`);
  }
  const digits = hex.slice(0, UUID_HEX_LENGTH).split('');
  // Version 4 / RFC 4122 variant nibbles, so the shape is a valid UUID.
  digits[UUID_VERSION_INDEX] = '4';
  digits[UUID_VARIANT_INDEX] = '8';
  const value = digits.join('');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32),
  ].join('-');
}

export const bucketId = (serverId: string, name: string): string =>
  mockId('bucket', serverId, name);

export const iamUserId = (serverId: string, name: string): string =>
  mockId('iam-user', serverId, name);

export const iamGroupId = (serverId: string, name: string): string =>
  mockId('iam-group', serverId, name);

export const iamPolicyId = (serverId: string, name: string): string =>
  mockId('iam-policy', serverId, name);

export const accessKeyId = (serverId: string, keyId: string): string =>
  mockId('access-key', serverId, keyId);
