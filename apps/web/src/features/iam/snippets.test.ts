import type { CreatedKey } from '@storage-io/contracts';
import { describe, expect, it } from 'vitest';
import { CREDENTIALS_CSV_HEADERS, SNIPPET_KINDS, buildSnippet, credentialsCsvRow } from './snippets';

/**
 * These snippets are pasted into a shell or a config file straight from the
 * one-time secret dialog, so every one of them has to carry the real endpoint and
 * the real region — a placeholder here is a broken deployment at 2 a.m.
 */

const created: CreatedKey = {
  accessKey: {
    serverId: 'srv-1',
    serverName: 'minio-prod-01',
    provider: 'minio',
    accessKeyId: 'SIO7K2QW9XP4RM81NB3C',
    userName: 'ci-deployer',
    name: 'GitHub Actions',
    status: 'active',
    restricted: false,
    createdAt: '2026-09-28T00:00:00.000Z',
    expiresAt: '2026-12-27T00:00:00.000Z',
    lastUsedAt: null,
    rotation: null,
  },
  secretAccessKey: 'q9Zr+Lw2sYx8vT4bN1mK0pHc7eJfGd5aUoRiWtEy',
  endpoint: 'https://s3.prod.acme.local:9000',
  region: 'us-east-1',
};

describe('buildSnippet', () => {
  it('puts the real key, secret, endpoint and region in every snippet', () => {
    for (const kind of SNIPPET_KINDS) {
      const snippet = buildSnippet(kind, { created, alias: 'minio-prod-01' });
      expect(snippet).toContain(created.accessKey.accessKeyId);
      expect(snippet).toContain(created.secretAccessKey);
      expect(snippet).toContain(created.endpoint);
    }
  });

  it('uses the server slug as the profile and alias name', () => {
    expect(buildSnippet('awscli', { created, alias: 'minio-prod-01' })).toContain(
      '--profile minio-prod-01',
    );
    expect(buildSnippet('rclone', { created, alias: 'minio-prod-01' })).toContain(
      '[minio-prod-01]',
    );
    expect(buildSnippet('mc', { created, alias: 'minio-prod-01' })).toContain(
      'mc alias set minio-prod-01',
    );
  });

  it("maps the provider onto rclone's own name for it", () => {
    expect(buildSnippet('rclone', { created, alias: 'x' })).toContain('provider = Minio');
    const onWasabi: CreatedKey = {
      ...created,
      accessKey: { ...created.accessKey, provider: 'wasabi' },
    };
    expect(buildSnippet('rclone', { created: onWasabi, alias: 'x' })).toContain(
      'provider = Wasabi',
    );
  });

  it('writes the .env keys the AWS SDKs actually read', () => {
    const env = buildSnippet('env', { created, alias: 'x' });
    expect(env).toContain('AWS_ACCESS_KEY_ID=');
    expect(env).toContain('AWS_SECRET_ACCESS_KEY=');
    expect(env).toContain('AWS_ENDPOINT_URL=');
    expect(env).toContain('AWS_REGION=us-east-1');
  });
});

describe('credentialsCsvRow', () => {
  it('lines up with the headers', () => {
    expect(credentialsCsvRow(created)).toHaveLength(CREDENTIALS_CSV_HEADERS.length);
  });

  it('leaves an absent expiry empty rather than writing "null"', () => {
    const noExpiry: CreatedKey = {
      ...created,
      accessKey: { ...created.accessKey, expiresAt: null, name: null },
    };
    const row = credentialsCsvRow(noExpiry);
    expect(row.at(-1)).toBe('');
    expect(row).not.toContain('null');
  });
});
