import { describe, expect, it } from 'vitest';
import type { Bucket } from '@storage-io/contracts';
import { mapWithConcurrency, rotateFrom } from '../../src/modules/inventory/inventory.service';
import { supportOf, usageRatioOf } from '../../src/modules/quotas/quotas.service';
import { formatBytes } from '../../src/modules/quotas/quota-watcher.service';

const bucket = (overrides: Partial<Bucket> = {}): Bucket => ({
  id: 'bucket-0000-4000-8000-000000000001',
  serverId: 'srv',
  serverName: 'minio',
  provider: 'minio',
  name: 'reports',
  region: 'us-east-1',
  createdAt: null,
  objects: 10,
  sizeBytes: 500,
  statsAt: null,
  versioning: 'off',
  objectLock: false,
  access: 'private',
  quota: null,
  unavailable: false,
  ...overrides,
});

describe('rotateFrom', () => {
  it('starts the list where the previous pass stopped', () => {
    expect(rotateFrom(['a', 'b', 'c', 'd'], 'c')).toEqual(['c', 'd', 'a', 'b']);
  });

  it('leaves the list alone with no cursor', () => {
    expect(rotateFrom(['a', 'b'], undefined)).toEqual(['a', 'b']);
  });

  it('leaves the list alone when the cursor is already first', () => {
    expect(rotateFrom(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });

  it('leaves the list alone when the remembered bucket is gone', () => {
    // The bucket was deleted between passes; starting over is the right fallback.
    expect(rotateFrom(['a', 'b'], 'deleted')).toEqual(['a', 'b']);
  });
});

describe('mapWithConcurrency', () => {
  it('visits every item exactly once', async () => {
    const items = Array.from({ length: 25 }, (_, index) => index);
    const seen: number[] = [];
    await mapWithConcurrency(items, 4, (item) => {
      seen.push(item);
      return Promise.resolve();
    });
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it('never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('does nothing for an empty list', async () => {
    let calls = 0;
    await mapWithConcurrency([], 4, () => {
      calls += 1;
      return Promise.resolve();
    });
    expect(calls).toBe(0);
  });
});

describe('usageRatioOf', () => {
  it('is the used share of the limit', () => {
    expect(
      usageRatioOf(
        bucket({
          sizeBytes: 500,
          quota: { limitBytes: 1000, mode: 'hard', threshold: 0.8, native: true },
        }),
      ),
    ).toBe(0.5);
  });

  it('is null without a quota', () => {
    expect(usageRatioOf(bucket({ quota: null }))).toBeNull();
  });

  it('is null when the size is unknown', () => {
    // A bucket bigger than the scan budget has no size; a ratio computed from a
    // missing number would render as 0% and read as "empty".
    expect(
      usageRatioOf(
        bucket({
          sizeBytes: null,
          quota: { limitBytes: 1000, mode: 'hard', threshold: 0.8, native: true },
        }),
      ),
    ).toBeNull();
  });
});

describe('supportOf', () => {
  it('is native when the provider enforces the limit too', () => {
    expect(
      supportOf(bucket({ quota: { limitBytes: 1, mode: 'hard', threshold: 0.8, native: true } })),
    ).toBe('native');
  });

  it('is alert-only when only storage-io holds the limit', () => {
    expect(
      supportOf(bucket({ quota: { limitBytes: 1, mode: 'alert', threshold: 0.8, native: false } })),
    ).toBe('alert-only');
  });

  it('is unavailable when the numbers come from an offline server', () => {
    expect(
      supportOf(
        bucket({
          unavailable: true,
          quota: { limitBytes: 1, mode: 'hard', threshold: 0.8, native: true },
        }),
      ),
    ).toBe('unavailable');
  });
});

describe('formatBytes', () => {
  it('uses decimal units, matching the region default', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1 KB');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(2_000_000_000)).toBe('2 GB');
  });

  it('stops at the largest unit it knows', () => {
    expect(formatBytes(5_000_000_000_000_000_000)).toContain('PB');
  });
});
