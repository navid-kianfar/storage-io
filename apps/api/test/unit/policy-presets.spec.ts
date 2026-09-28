import { describe, expect, it } from 'vitest';
import {
  accessFromPolicy,
  bucketArn,
  objectsArn,
  policyForAccess,
  publicReadPolicy,
} from '../../src/modules/buckets/policy-presets';

/**
 * These tests are about *effect*, not shape: what matters is whether a policy the
 * API writes, or one an operator wrote by hand, is correctly reported as private,
 * public-read or custom. A bucket shown as private while it serves objects to the
 * world is the worst failure this module can have, so the `custom` cases are the
 * ones worth reading.
 */
describe('publicReadPolicy', () => {
  it('grants anonymous object reads and a listable bucket, and nothing else', () => {
    const policy = publicReadPolicy('reports');
    const statements = policy['Statement'] as readonly Record<string, unknown>[];

    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement['Effect']).toBe('Allow');
      expect(statement['Principal']).toEqual({ AWS: ['*'] });
    }
    expect(statements[0]?.['Action']).toEqual(['s3:GetObject']);
    expect(statements[0]?.['Resource']).toEqual(['arn:aws:s3:::reports/*']);
    expect(statements[1]?.['Action']).toEqual(['s3:ListBucket']);
    expect(statements[1]?.['Resource']).toEqual(['arn:aws:s3:::reports']);
  });

  it('is classified back as public-read', () => {
    expect(accessFromPolicy(publicReadPolicy('reports'), 'reports')).toBe('public-read');
  });

  it('is not public-read for a different bucket', () => {
    // The ARNs name the bucket, so the same document on another bucket grants
    // nothing there and must not be reported as that bucket's preset.
    expect(accessFromPolicy(publicReadPolicy('reports'), 'other')).toBe('custom');
  });
});

describe('policyForAccess', () => {
  it('has no policy for private', () => {
    expect(policyForAccess('private', 'reports')).toBeNull();
  });

  it('produces the public-read preset', () => {
    expect(policyForAccess('public-read', 'reports')).toEqual(publicReadPolicy('reports'));
  });
});

describe('accessFromPolicy', () => {
  it('reports private when there is no policy at all', () => {
    expect(accessFromPolicy(null, 'reports')).toBe('private');
    expect(accessFromPolicy(undefined, 'reports')).toBe('private');
    expect(accessFromPolicy({ Version: '2012-10-17' }, 'reports')).toBe('private');
    expect(accessFromPolicy({ Version: '2012-10-17', Statement: [] }, 'reports')).toBe('private');
  });

  it('recognises the minimal public-read another tool writes', () => {
    // `mc anonymous set download` writes exactly this: one statement, no ListBucket.
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [objectsArn('reports')],
        },
      ],
    };
    expect(accessFromPolicy(policy, 'reports')).toBe('public-read');
  });

  it('accepts every spelling of the anonymous principal', () => {
    for (const principal of ['*', { AWS: '*' }, { AWS: ['*'] }]) {
      const policy = {
        Statement: [
          {
            Effect: 'Allow',
            Principal: principal,
            Action: 's3:GetObject',
            Resource: objectsArn('reports'),
          },
        ],
      };
      expect(accessFromPolicy(policy, 'reports')).toBe('public-read');
    }
  });

  it('is case-insensitive about Effect, as IAM is', () => {
    const policy = {
      Statement: [
        {
          Effect: 'allow',
          Principal: '*',
          Action: 's3:GetObject',
          Resource: objectsArn('reports'),
        },
      ],
    };
    expect(accessFromPolicy(policy, 'reports')).toBe('public-read');
  });

  it('reports custom when anonymous writes are granted', () => {
    const policy = {
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject', 's3:PutObject'],
          Resource: [objectsArn('reports')],
        },
      ],
    };
    expect(accessFromPolicy(policy, 'reports')).toBe('custom');
  });

  it('reports custom for a named principal, not the world', () => {
    const policy = {
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['arn:aws:iam::123456789012:user/alice'] },
          Action: ['s3:GetObject'],
          Resource: [objectsArn('reports')],
        },
      ],
    };
    expect(accessFromPolicy(policy, 'reports')).toBe('custom');
  });

  it('reports custom when a condition narrows the grant', () => {
    // The grant is real but conditional; presenting it as a preset would let the
    // UI overwrite the condition without the operator noticing.
    const policy = {
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [objectsArn('reports')],
          Condition: { IpAddress: { 'aws:SourceIp': '10.0.0.0/8' } },
        },
      ],
    };
    expect(accessFromPolicy(policy, 'reports')).toBe('custom');
  });

  it('reports custom when a Deny is mixed in', () => {
    const policy = {
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [objectsArn('reports')],
        },
        {
          Effect: 'Deny',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`${objectsArn('reports')}private/*`],
        },
      ],
    };
    expect(accessFromPolicy(policy, 'reports')).toBe('custom');
  });

  it('reports custom when NotAction or NotResource inverts the match', () => {
    for (const inverted of [{ NotAction: ['s3:PutObject'] }, { NotResource: ['x'] }]) {
      const policy = {
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: ['s3:GetObject'],
            Resource: [objectsArn('reports')],
            ...inverted,
          },
        ],
      };
      expect(accessFromPolicy(policy, 'reports')).toBe('custom');
    }
  });

  it('reports custom for a list-only policy: nothing anonymous can be read', () => {
    const policy = {
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:ListBucket'],
          Resource: [bucketArn('reports')],
        },
      ],
    };
    expect(accessFromPolicy(policy, 'reports')).toBe('custom');
  });

  it('reports custom for something that is not a policy document', () => {
    expect(accessFromPolicy({ Statement: 'nonsense' }, 'reports')).toBe('custom');
    expect(accessFromPolicy({ Statement: [1, 2] }, 'reports')).toBe('custom');
    expect(accessFromPolicy('a string', 'reports')).toBe('custom');
  });
});
