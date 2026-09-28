import { describe, expect, it } from 'vitest';
import { quotaRowsToCsv } from './api';

/**
 * The quotas export is built in the browser (`/quotas` has no export endpoint), so
 * the escaping is this app's problem: a bucket name with a comma or a quote in it
 * must not shift every following column by one.
 */

const HEADERS = ['Server', 'Bucket', 'Used bytes', 'Limit bytes', 'Ratio', 'Mode', 'Alert', 'Support'];

describe('quotaRowsToCsv', () => {
  it('writes the header first and one line per row', () => {
    const csv = quotaRowsToCsv(
      [
        {
          server: 'minio-prod-01',
          bucket: 'media-prod',
          usedBytes: 3.2e12,
          limitBytes: 4e12,
          usageRatio: 0.8,
          mode: 'hard',
          threshold: 0.8,
          support: 'native',
        },
      ],
      HEADERS,
    );
    const lines = csv.split('\n');
    expect(lines[0]).toBe(HEADERS.join(','));
    expect(lines[1]).toBe('minio-prod-01,media-prod,3200000000000,4000000000000,0.8,hard,0.8,native');
  });

  it('quotes a value containing a comma, a quote or a newline', () => {
    const csv = quotaRowsToCsv(
      [
        {
          server: 'lab, west',
          bucket: 'say "hi"',
          usedBytes: 1,
          limitBytes: null,
          usageRatio: null,
          mode: '',
          threshold: null,
          support: 'alert-only',
        },
      ],
      HEADERS,
    );
    const row = csv.split('\n')[1] ?? '';
    expect(row).toContain('"lab, west"');
    expect(row).toContain('"say ""hi"""');
  });

  it('writes an empty cell for a missing number rather than "null"', () => {
    const csv = quotaRowsToCsv(
      [
        {
          server: 's',
          bucket: 'b',
          usedBytes: null,
          limitBytes: null,
          usageRatio: null,
          mode: '',
          threshold: null,
          support: 'unavailable',
        },
      ],
      HEADERS,
    );
    expect(csv.split('\n')[1]).toBe('s,b,,,,,,unavailable');
  });
});
