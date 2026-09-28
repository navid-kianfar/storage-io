import { describe, expect, it } from 'vitest';
import { isValidBucketName } from '../src/helpers/bucket-name.js';
import { matchesAnyGlob, matchesGlob } from '../src/helpers/glob.js';
import { SETTINGS_DEFAULTS, settingsSchema } from '../src/settings.js';
import { createServerRequestSchema } from '../src/servers.js';
import { bucketBulkRequestSchema } from '../src/buckets.js';

describe('isValidBucketName', () => {
  it('accepts the names the UI suggests', () => {
    for (const name of ['reports', 'media-assets', 'team.backups', 'a1b']) {
      expect(isValidBucketName(name).valid, name).toBe(true);
    }
  });

  it('names the reason a bucket name is rejected', () => {
    expect(isValidBucketName('ab').problem).toBe('too-short');
    expect(isValidBucketName('a'.repeat(64)).problem).toBe('too-long');
    expect(isValidBucketName('My-Bucket').problem).toBe('invalid-characters');
    expect(isValidBucketName('under_score').problem).toBe('invalid-characters');
    expect(isValidBucketName('-leading').problem).toBe('must-start-and-end-alphanumeric');
    expect(isValidBucketName('trailing.').problem).toBe('must-start-and-end-alphanumeric');
    expect(isValidBucketName('a..b').problem).toBe('consecutive-dots');
    expect(isValidBucketName('a.-b').problem).toBe('dash-adjacent-dot');
    expect(isValidBucketName('192.168.0.1').problem).toBe('ip-address');
    expect(isValidBucketName('xn--bucket').problem).toBe('reserved-prefix');
    expect(isValidBucketName('bucket-s3alias').problem).toBe('reserved-suffix');
  });

  it('carries a message whenever it rejects, and none when it accepts', () => {
    expect(isValidBucketName('ab').message).toBeTypeOf('string');
    expect(isValidBucketName('reports').message).toBeNull();
  });
});

describe('matchesGlob', () => {
  it('matches `*` across separators, as S3 prefixes imply', () => {
    expect(matchesGlob('*.log', 'app.log')).toBe(true);
    expect(matchesGlob('logs/*', 'logs/2026/01/app.log')).toBe(true);
    expect(matchesGlob('*.log', 'app.log.gz')).toBe(false);
  });

  it('matches `?` as exactly one character', () => {
    expect(matchesGlob('log-?.txt', 'log-1.txt')).toBe(true);
    expect(matchesGlob('log-?.txt', 'log-12.txt')).toBe(false);
  });

  it('supports character classes, including negation and ranges', () => {
    expect(matchesGlob('part-[0-9].bin', 'part-7.bin')).toBe(true);
    expect(matchesGlob('part-[0-9].bin', 'part-x.bin')).toBe(false);
    expect(matchesGlob('part-[!0-9].bin', 'part-x.bin')).toBe(true);
    expect(matchesGlob('part-[!0-9].bin', 'part-7.bin')).toBe(false);
  });

  it('supports brace alternation', () => {
    expect(matchesGlob('*.{jpg,png}', 'photo.png')).toBe(true);
    expect(matchesGlob('*.{jpg,png}', 'photo.gif')).toBe(false);
  });

  it('treats regex metacharacters outside the glob syntax as literals', () => {
    expect(matchesGlob('a+b.txt', 'a+b.txt')).toBe(true);
    expect(matchesGlob('a+b.txt', 'aab.txt')).toBe(false);
    expect(matchesGlob('report(1).csv', 'report(1).csv')).toBe(true);
    expect(matchesGlob('a.b', 'axb')).toBe(false);
  });

  it('is anchored at both ends', () => {
    expect(matchesGlob('log', 'catalog')).toBe(false);
    expect(matchesGlob('log', 'log')).toBe(true);
  });

  it('honours the case-insensitive option', () => {
    expect(matchesGlob('*.LOG', 'app.log')).toBe(false);
    expect(matchesGlob('*.LOG', 'app.log', { caseInsensitive: true })).toBe(true);
  });

  it('survives an unterminated brace or bracket instead of throwing', () => {
    expect(() => matchesGlob('a{b', 'a{b')).not.toThrow();
    expect(() => matchesGlob('a[b', 'a[b')).not.toThrow();
    expect(matchesGlob('a[b', 'a[b')).toBe(true);
  });

  it('matchesAnyGlob is false for an empty pattern list', () => {
    expect(matchesAnyGlob([], 'anything')).toBe(false);
    expect(matchesAnyGlob(['*.log', '*.txt'], 'a.txt')).toBe(true);
  });
});

describe('schemas', () => {
  it('SETTINGS_DEFAULTS satisfies settingsSchema', () => {
    expect(settingsSchema.safeParse(SETTINGS_DEFAULTS).success).toBe(true);
  });

  it('createServerRequestSchema fills in the option defaults it is given none of', () => {
    const parsed = createServerRequestSchema.parse({
      name: 'minio-lab',
      provider: 'minio',
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });
    expect(parsed.options).toEqual({});
  });

  it('createServerRequestSchema rejects a name that is not a slug', () => {
    const attempt = createServerRequestSchema.safeParse({
      name: 'MinIO Lab',
      provider: 'minio',
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });
    expect(attempt.success).toBe(false);
  });

  it('bucketBulkRequestSchema keeps each action with its own payload', () => {
    const ok = bucketBulkRequestSchema.safeParse({
      buckets: [{ serverId: 's1', bucket: 'reports' }],
      action: 'tags',
      payload: { tags: { env: 'prod' } },
    });
    expect(ok.success).toBe(true);

    const mismatched = bucketBulkRequestSchema.safeParse({
      buckets: [{ serverId: 's1', bucket: 'reports' }],
      action: 'quota',
      payload: { tags: { env: 'prod' } },
    });
    expect(mismatched.success).toBe(false);
  });
});
