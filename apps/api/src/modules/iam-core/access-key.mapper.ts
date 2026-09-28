import { ACCESS_KEY_EXPIRING_DAYS, type AccessKey, type Provider } from '@storage-io/contracts';
import type { KeyMetaRow } from '../../db/schema';
import type { RawAccessKey } from '../../providers/iam/iam-driver';

/**
 * Merging what the provider says about a key with what storage-io tracks itself.
 *
 * The rules, and why:
 *
 * - **Expiry**: the provider's value wins where it has one (MinIO enforces it);
 *   otherwise `key_meta`'s, which the scheduler enforces. A key past its expiry
 *   reads as `expired` even before the sweep has run, so the list never shows a
 *   key as usable when it is not.
 * - **Status**: the provider's enabled flag decides between `active` and
 *   `disabled`, because that is the thing that actually gates a request. The
 *   stored status is bookkeeping for the sweep, not the answer.
 * - **`restricted`**: either source saying yes is yes. MinIO drops
 *   `impliedPolicy: false` after any `update-service-account`, so trusting only
 *   the provider would quietly un-flag a session-scoped key.
 * - **Name, creation, last use**: the provider where it knows, `key_meta` where it
 *   does not.
 */

export interface KeyServerStamp {
  readonly serverId: string;
  readonly serverName: string;
  readonly provider: Provider;
}

export function toAccessKey(
  stamp: KeyServerStamp,
  raw: RawAccessKey,
  meta: KeyMetaRow | undefined,
  now: Date = new Date(),
): AccessKey {
  const expiresAt = raw.expiresAt ?? meta?.expiresAt ?? null;

  return {
    ...stamp,
    accessKeyId: raw.accessKeyId,
    userName: raw.userName.length > 0 ? raw.userName : (meta?.userName ?? ''),
    name: raw.name ?? meta?.name ?? null,
    status: statusOf(raw, expiresAt, now),
    restricted: raw.restricted || meta?.restricted === true,
    createdAt: raw.createdAt ?? meta?.createdAt ?? null,
    expiresAt,
    lastUsedAt: raw.lastUsedAt ?? meta?.lastUsedAt ?? null,
    rotation: toRotation(meta),
  };
}

/** Expiry first: a key past its date is expired whatever the provider still says. */
function statusOf(raw: RawAccessKey, expiresAt: string | null, now: Date): AccessKey['status'] {
  if (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()) return 'expired';
  return raw.enabled ? 'active' : 'disabled';
}

function toRotation(meta: KeyMetaRow | undefined): AccessKey['rotation'] {
  if (meta === undefined) return null;
  if (meta.rotationReplacedBy === null || meta.rotationDisableAt === null) return null;
  return { replacedBy: meta.rotationReplacedBy, disableAt: meta.rotationDisableAt };
}

/** `status=expiring`: active, with an expiry inside the shared window. */
export function isExpiringSoon(key: AccessKey, now: Date = new Date()): boolean {
  if (key.status !== 'active' || key.expiresAt === null) return false;
  const remainingMs = Date.parse(key.expiresAt) - now.getTime();
  return remainingMs > 0 && remainingMs <= ACCESS_KEY_EXPIRING_DAYS * 86_400_000;
}

/**
 * The counts `GET /iam/access-keys` returns. They describe the whole filtered set
 * before paging, which is what the filter chips above the table show — so they are
 * computed from the full list rather than the page.
 */
export function countKeys(keys: readonly AccessKey[], now: Date = new Date()) {
  let active = 0;
  let expiring = 0;
  let disabled = 0;

  for (const key of keys) {
    if (key.status === 'active') active += 1;
    if (key.status === 'disabled') disabled += 1;
    if (isExpiringSoon(key, now)) expiring += 1;
  }

  return { all: keys.length, active, expiring, disabled };
}
