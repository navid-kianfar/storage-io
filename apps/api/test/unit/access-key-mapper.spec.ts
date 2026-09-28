import { describe, expect, it } from 'vitest';
import {
  countKeys,
  isExpiringSoon,
  toAccessKey,
  type KeyServerStamp,
} from '../../src/modules/iam-core/access-key.mapper';
import { matchesQuery, paginate } from '../../src/modules/iam-core/iam-page';
import type { KeyMetaRow } from '../../src/db/schema';
import type { RawAccessKey } from '../../src/providers/iam/iam-driver';

/**
 * The merge between what a provider reports about a key and what storage-io tracks
 * itself. These are the rules the keys screen depends on, and every one of them
 * exists because a provider does not report something: an expiry (IAM, RGW,
 * Garage), a name (IAM, RGW), or a session policy that survives an update (MinIO).
 */

const STAMP: KeyServerStamp = {
  serverId: 'server-1',
  serverName: 'minio-lab',
  provider: 'minio',
};

const NOW = new Date('2026-06-01T12:00:00.000Z');

const rawKey = (overrides: Partial<RawAccessKey> = {}): RawAccessKey => ({
  accessKeyId: 'AKIA0000000000000001',
  userName: 'alice',
  name: null,
  enabled: true,
  restricted: false,
  createdAt: null,
  expiresAt: null,
  lastUsedAt: null,
  ...overrides,
});

const metaRow = (overrides: Partial<KeyMetaRow> = {}): KeyMetaRow => ({
  serverId: 'server-1',
  accessKeyId: 'AKIA0000000000000001',
  userName: 'alice',
  name: null,
  createdAt: null,
  expiresAt: null,
  lastUsedAt: null,
  status: 'active',
  restricted: false,
  rotationReplacedBy: null,
  rotationDisableAt: null,
  expiryNotifiedAt: null,
  updatedAt: NOW.toISOString(),
  ...overrides,
});

describe('toAccessKey', () => {
  it('reports an active key with nothing tracked about it', () => {
    const key = toAccessKey(STAMP, rawKey(), undefined, NOW);

    expect(key.status).toBe('active');
    expect(key.expiresAt).toBeNull();
    expect(key.name).toBeNull();
    expect(key.rotation).toBeNull();
    expect(key.serverName).toBe('minio-lab');
  });

  it("prefers the provider's own expiry over the tracked one", () => {
    const key = toAccessKey(
      STAMP,
      rawKey({ expiresAt: '2026-07-01T00:00:00.000Z' }),
      metaRow({ expiresAt: '2030-01-01T00:00:00.000Z' }),
      NOW,
    );

    expect(key.expiresAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('falls back to the tracked expiry where the provider has none', () => {
    const key = toAccessKey(
      STAMP,
      rawKey(),
      metaRow({ expiresAt: '2026-07-01T00:00:00.000Z' }),
      NOW,
    );

    expect(key.expiresAt).toBe('2026-07-01T00:00:00.000Z');
    expect(key.status).toBe('active');
  });

  it('reads as expired past its date even while the provider still enables it', () => {
    const key = toAccessKey(
      STAMP,
      rawKey({ enabled: true }),
      metaRow({ expiresAt: '2026-05-31T00:00:00.000Z' }),
      NOW,
    );

    // The sweep may not have run yet; the list must not offer the key as usable.
    expect(key.status).toBe('expired');
  });

  it('reports disabled from the provider, not from what was recorded', () => {
    const key = toAccessKey(STAMP, rawKey({ enabled: false }), metaRow({ status: 'active' }), NOW);

    expect(key.status).toBe('disabled');
  });

  it('keeps restricted when only the tracked row remembers the session policy', () => {
    // MinIO drops `impliedPolicy: false` after any update-service-account, so the
    // provider stops admitting a key is scoped. The recorded flag is the authority.
    const key = toAccessKey(
      STAMP,
      rawKey({ restricted: false }),
      metaRow({ restricted: true }),
      NOW,
    );

    expect(key.restricted).toBe(true);
  });

  it('takes the name and creation time from the tracked row where the provider has none', () => {
    const key = toAccessKey(
      STAMP,
      rawKey(),
      metaRow({ name: 'backup runner', createdAt: '2026-01-02T03:04:05.000Z' }),
      NOW,
    );

    expect(key.name).toBe('backup runner');
    expect(key.createdAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('exposes a rotation in flight only when both halves are recorded', () => {
    const half = toAccessKey(
      STAMP,
      rawKey(),
      metaRow({ rotationReplacedBy: 'AKIA0000000000000002' }),
      NOW,
    );
    expect(half.rotation).toBeNull();

    const full = toAccessKey(
      STAMP,
      rawKey(),
      metaRow({
        rotationReplacedBy: 'AKIA0000000000000002',
        rotationDisableAt: '2026-06-01T13:00:00.000Z',
      }),
      NOW,
    );
    expect(full.rotation).toEqual({
      replacedBy: 'AKIA0000000000000002',
      disableAt: '2026-06-01T13:00:00.000Z',
    });
  });

  it('falls back to the tracked user name when the provider omits the parent', () => {
    const key = toAccessKey(STAMP, rawKey({ userName: '' }), metaRow({ userName: 'bob' }), NOW);

    expect(key.userName).toBe('bob');
  });
});

describe('isExpiringSoon', () => {
  const within = new Date(NOW.getTime() + 3 * 86_400_000).toISOString();
  const beyond = new Date(NOW.getTime() + 30 * 86_400_000).toISOString();

  it('is true for an active key expiring inside the window', () => {
    const key = toAccessKey(STAMP, rawKey({ expiresAt: within }), undefined, NOW);
    expect(isExpiringSoon(key, NOW)).toBe(true);
  });

  it('is false beyond the window', () => {
    const key = toAccessKey(STAMP, rawKey({ expiresAt: beyond }), undefined, NOW);
    expect(isExpiringSoon(key, NOW)).toBe(false);
  });

  it('is false for a key with no expiry at all', () => {
    const key = toAccessKey(STAMP, rawKey(), undefined, NOW);
    expect(isExpiringSoon(key, NOW)).toBe(false);
  });

  it('is false once the key is disabled — there is nothing to renew', () => {
    const key = toAccessKey(STAMP, rawKey({ enabled: false, expiresAt: within }), undefined, NOW);
    expect(isExpiringSoon(key, NOW)).toBe(false);
  });
});

describe('countKeys', () => {
  it('counts each state, and an expiring key as active too', () => {
    const soon = new Date(NOW.getTime() + 86_400_000).toISOString();
    const keys = [
      toAccessKey(STAMP, rawKey({ accessKeyId: 'a' }), undefined, NOW),
      toAccessKey(STAMP, rawKey({ accessKeyId: 'b', expiresAt: soon }), undefined, NOW),
      toAccessKey(STAMP, rawKey({ accessKeyId: 'c', enabled: false }), undefined, NOW),
      toAccessKey(
        STAMP,
        rawKey({ accessKeyId: 'd', expiresAt: '2026-01-01T00:00:00.000Z' }),
        undefined,
        NOW,
      ),
    ];

    // An expiring key still works, so it is counted in both places on purpose —
    // the chips are filters, not a partition.
    expect(countKeys(keys, NOW)).toEqual({ all: 4, active: 2, expiring: 1, disabled: 1 });
  });
});

describe('paginate', () => {
  const items = [1, 2, 3, 4, 5, 6, 7];

  it('cuts the requested page and reports the whole total', () => {
    expect(paginate(items, 2, 3)).toEqual({ items: [4, 5, 6], total: 7 });
  });

  it('returns an empty page past the end, with the total intact', () => {
    expect(paginate(items, 9, 3)).toEqual({ items: [], total: 7 });
  });
});

describe('matchesQuery', () => {
  it('matches any field, ignoring case, and skips nulls', () => {
    expect(matchesQuery('BACK', 'alice', 'backup runner')).toBe(true);
    expect(matchesQuery('zz', 'alice', null)).toBe(false);
  });

  it('matches everything when no query was given', () => {
    expect(matchesQuery(undefined, 'alice')).toBe(true);
    expect(matchesQuery('', 'alice')).toBe(true);
  });
});
