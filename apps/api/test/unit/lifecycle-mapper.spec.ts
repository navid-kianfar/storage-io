import { describe, expect, it } from 'vitest';
import type { LifecycleRule } from '@storage-io/contracts';
import {
  fromS3Lifecycle,
  fromS3LifecycleRule,
  toS3Lifecycle,
  toS3LifecycleRule,
} from '../../src/modules/buckets/mappers/lifecycle.mapper';

const base: LifecycleRule = {
  id: 'expire-logs',
  enabled: true,
  prefix: 'logs/',
  tags: {},
  expireDays: 30,
  noncurrentExpireDays: null,
  abortMultipartDays: null,
  transition: null,
  expiredDeleteMarkers: false,
};

describe('lifecycle mapper', () => {
  it('round-trips a rule through the S3 shape unchanged', () => {
    const rule: LifecycleRule = {
      ...base,
      noncurrentExpireDays: 7,
      abortMultipartDays: 3,
      transition: { days: 10, storageClass: 'GLACIER' },
    };
    expect(fromS3LifecycleRule(toS3LifecycleRule(rule), 0)).toEqual(rule);
  });

  it('round-trips a disabled rule with no prefix', () => {
    const rule: LifecycleRule = { ...base, enabled: false, prefix: '' };
    expect(fromS3LifecycleRule(toS3LifecycleRule(rule), 0)).toEqual(rule);
  });

  it('round-trips a list in order', () => {
    const rules: readonly LifecycleRule[] = [base, { ...base, id: 'second', prefix: 'tmp/' }];
    expect(fromS3Lifecycle(toS3Lifecycle(rules))).toEqual(rules);
  });

  describe('the filter, which S3 spells three different ways', () => {
    it('uses a bare Prefix when there are no tags', () => {
      expect(toS3LifecycleRule(base).Filter).toEqual({ Prefix: 'logs/' });
    });

    it('uses a bare Tag for one tag and no prefix', () => {
      const rule: LifecycleRule = { ...base, prefix: '', tags: { stage: 'archive' } };
      expect(toS3LifecycleRule(rule).Filter).toEqual({ Tag: { Key: 'stage', Value: 'archive' } });
      expect(fromS3LifecycleRule(toS3LifecycleRule(rule), 0)).toEqual(rule);
    });

    it('uses And for a prefix plus a tag', () => {
      const rule: LifecycleRule = { ...base, tags: { stage: 'archive' } };
      expect(toS3LifecycleRule(rule).Filter).toEqual({
        And: { Prefix: 'logs/', Tags: [{ Key: 'stage', Value: 'archive' }] },
      });
      expect(fromS3LifecycleRule(toS3LifecycleRule(rule), 0)).toEqual(rule);
    });

    it('uses And for several tags with no prefix', () => {
      const rule: LifecycleRule = { ...base, prefix: '', tags: { a: '1', b: '2' } };
      expect(toS3LifecycleRule(rule).Filter).toEqual({
        And: {
          Tags: [
            { Key: 'a', Value: '1' },
            { Key: 'b', Value: '2' },
          ],
        },
      });
      expect(fromS3LifecycleRule(toS3LifecycleRule(rule), 0)).toEqual(rule);
    });

    it('reads the deprecated top-level Prefix an older tool wrote', () => {
      // Dropping it would silently widen the rule from one prefix to the bucket.
      const read = fromS3LifecycleRule({ ID: 'old', Status: 'Enabled', Prefix: 'logs/' }, 0);
      expect(read.prefix).toBe('logs/');
    });
  });

  describe('expiration, where Days and ExpiredObjectDeleteMarker are exclusive', () => {
    it('sends Days when a day count is set', () => {
      expect(toS3LifecycleRule(base).Expiration).toEqual({ Days: 30 });
    });

    it('sends ExpiredObjectDeleteMarker only when there is no day count', () => {
      const rule: LifecycleRule = { ...base, expireDays: null, expiredDeleteMarkers: true };
      expect(toS3LifecycleRule(rule).Expiration).toEqual({ ExpiredObjectDeleteMarker: true });
      expect(fromS3LifecycleRule(toS3LifecycleRule(rule), 0)).toEqual(rule);
    });

    it('prefers Days when a rule asks for both, because S3 rejects both', () => {
      const rule: LifecycleRule = { ...base, expireDays: 30, expiredDeleteMarkers: true };
      expect(toS3LifecycleRule(rule).Expiration).toEqual({ Days: 30 });
    });

    it('omits Expiration entirely when neither is asked for', () => {
      const rule: LifecycleRule = { ...base, expireDays: null };
      expect(toS3LifecycleRule(rule).Expiration).toBeUndefined();
    });
  });

  it('gives a rule with no ID a stable one from its position', () => {
    // The contract requires an id and the UI needs a key; the position is the only
    // stable thing a provider that dropped the ID leaves behind.
    expect(fromS3LifecycleRule({ Status: 'Enabled' }, 2).id).toBe('rule-3');
  });
});
