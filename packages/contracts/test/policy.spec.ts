import { describe, expect, it } from 'vitest';
import {
  evaluatePolicy,
  validatePolicyDocument,
  type PolicyDocument,
} from '../src/helpers/policy.js';

const allowGetObject: PolicyDocument = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'ReadReports',
      Effect: 'Allow',
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::reports/*'],
    },
  ],
};

describe('evaluatePolicy — effects', () => {
  it('allows a matching action and resource, naming the statement', () => {
    const result = evaluatePolicy(allowGetObject, {
      action: 's3:GetObject',
      resource: 'arn:aws:s3:::reports/2026/q1.csv',
    });

    expect(result.decision).toBe('allow');
    expect(result.statementSid).toBe('ReadReports');
    expect(result.statementIndex).toBe(0);
  });

  it('implicitly denies an action no statement mentions', () => {
    const result = evaluatePolicy(allowGetObject, {
      action: 's3:DeleteObject',
      resource: 'arn:aws:s3:::reports/2026/q1.csv',
    });

    expect(result.decision).toBe('implicit-deny');
    expect(result.statementSid).toBeNull();
    expect(result.statementIndex).toBeNull();
  });

  it('implicitly denies a resource outside the statement', () => {
    const result = evaluatePolicy(allowGetObject, {
      action: 's3:GetObject',
      resource: 'arn:aws:s3:::payroll/2026/q1.csv',
    });

    expect(result.decision).toBe('implicit-deny');
  });

  it('lets an explicit Deny beat an Allow regardless of order', () => {
    const document: PolicyDocument = {
      Statement: [
        { Sid: 'Allow', Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::reports/*' },
        {
          Sid: 'DenyArchive',
          Effect: 'Deny',
          Action: 's3:*',
          Resource: 'arn:aws:s3:::reports/archive/*',
        },
      ],
    };

    const denied = evaluatePolicy(document, {
      action: 's3:GetObject',
      resource: 'arn:aws:s3:::reports/archive/old.csv',
    });
    expect(denied.decision).toBe('deny');
    expect(denied.statementSid).toBe('DenyArchive');

    const allowed = evaluatePolicy(document, {
      action: 's3:GetObject',
      resource: 'arn:aws:s3:::reports/new.csv',
    });
    expect(allowed.decision).toBe('allow');
  });

  it('ignores a statement whose Effect is neither Allow nor Deny', () => {
    const result = evaluatePolicy(
      { Statement: [{ Effect: 'Permit', Action: '*', Resource: '*' }] },
      { action: 's3:GetObject', resource: 'arn:aws:s3:::a/b' },
    );
    expect(result.decision).toBe('implicit-deny');
  });

  it('treats a missing or empty document as implicit-deny', () => {
    expect(evaluatePolicy(null, { action: 's3:GetObject', resource: 'x' }).decision).toBe(
      'implicit-deny',
    );
    expect(evaluatePolicy({}, { action: 's3:GetObject', resource: 'x' }).decision).toBe(
      'implicit-deny',
    );
  });

  it('accepts a single statement object as well as an array', () => {
    const result = evaluatePolicy(
      { Statement: { Effect: 'Allow', Action: 's3:*', Resource: '*' } },
      { action: 's3:ListBucket', resource: 'arn:aws:s3:::anything' },
    );
    expect(result.decision).toBe('allow');
  });
});

describe('evaluatePolicy — wildcards', () => {
  it('matches `*` across any run of characters', () => {
    const document: PolicyDocument = {
      Statement: [{ Effect: 'Allow', Action: 's3:Get*', Resource: 'arn:aws:s3:::*/public/*' }],
    };
    expect(
      evaluatePolicy(document, {
        action: 's3:GetObjectTagging',
        resource: 'arn:aws:s3:::media/public/logo.png',
      }).decision,
    ).toBe('allow');
    expect(
      evaluatePolicy(document, {
        action: 's3:PutObject',
        resource: 'arn:aws:s3:::media/public/logo.png',
      }).decision,
    ).toBe('implicit-deny');
  });

  it('matches `?` as exactly one character', () => {
    const document: PolicyDocument = {
      Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::log-?/*' }],
    };
    expect(
      evaluatePolicy(document, { action: 's3:GetObject', resource: 'arn:aws:s3:::log-7/a' })
        .decision,
    ).toBe('allow');
    expect(
      evaluatePolicy(document, { action: 's3:GetObject', resource: 'arn:aws:s3:::log-77/a' })
        .decision,
    ).toBe('implicit-deny');
  });

  it('matches the action case-insensitively and the resource case-sensitively', () => {
    const document: PolicyDocument = {
      Statement: [{ Effect: 'Allow', Action: 's3:getobject', Resource: 'arn:aws:s3:::Reports/*' }],
    };
    expect(
      evaluatePolicy(document, { action: 'S3:GetObject', resource: 'arn:aws:s3:::Reports/a' })
        .decision,
    ).toBe('allow');
    expect(
      evaluatePolicy(document, { action: 's3:GetObject', resource: 'arn:aws:s3:::reports/a' })
        .decision,
    ).toBe('implicit-deny');
  });

  it('does not treat a glob brace or bracket as a wildcard', () => {
    const document: PolicyDocument = {
      Statement: [{ Effect: 'Allow', Action: 's3:{Get,Put}Object', Resource: '*' }],
    };
    expect(evaluatePolicy(document, { action: 's3:GetObject', resource: 'x' }).decision).toBe(
      'implicit-deny',
    );
  });
});

describe('evaluatePolicy — NotAction and NotResource', () => {
  it('matches every action except those listed', () => {
    const document: PolicyDocument = {
      Statement: [{ Effect: 'Deny', NotAction: ['s3:GetObject'], Resource: '*' }],
    };
    expect(evaluatePolicy(document, { action: 's3:DeleteObject', resource: 'x' }).decision).toBe(
      'deny',
    );
    expect(evaluatePolicy(document, { action: 's3:GetObject', resource: 'x' }).decision).toBe(
      'implicit-deny',
    );
  });

  it('matches every resource except those listed', () => {
    const document: PolicyDocument = {
      Statement: [{ Effect: 'Allow', Action: '*', NotResource: 'arn:aws:s3:::secret/*' }],
    };
    expect(
      evaluatePolicy(document, { action: 's3:GetObject', resource: 'arn:aws:s3:::public/a' })
        .decision,
    ).toBe('allow');
    expect(
      evaluatePolicy(document, { action: 's3:GetObject', resource: 'arn:aws:s3:::secret/a' })
        .decision,
    ).toBe('implicit-deny');
  });

  it('matches nothing when a statement names neither Action nor NotAction', () => {
    const result = evaluatePolicy(
      { Statement: [{ Effect: 'Allow', Resource: '*' }] },
      { action: 's3:GetObject', resource: 'x' },
    );
    expect(result.decision).toBe('implicit-deny');
  });
});

describe('evaluatePolicy — conditions', () => {
  it('StringEquals matches one of several expected values', () => {
    const document: PolicyDocument = {
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:ListBucket',
          Resource: 'arn:aws:s3:::reports',
          Condition: { StringEquals: { 's3:prefix': ['home/', 'shared/'] } },
        },
      ],
    };
    expect(
      evaluatePolicy(document, {
        action: 's3:ListBucket',
        resource: 'arn:aws:s3:::reports',
        context: { 's3:prefix': 'shared/' },
      }).decision,
    ).toBe('allow');
    expect(
      evaluatePolicy(document, {
        action: 's3:ListBucket',
        resource: 'arn:aws:s3:::reports',
        context: { 's3:prefix': 'other/' },
      }).decision,
    ).toBe('implicit-deny');
  });

  it('a plain operator fails when the context key is absent, IfExists passes', () => {
    const base = {
      Effect: 'Allow' as const,
      Action: 's3:GetObject',
      Resource: '*',
    };
    const strict: PolicyDocument = {
      Statement: [{ ...base, Condition: { StringEquals: { 'aws:username': 'ada' } } }],
    };
    const lenient: PolicyDocument = {
      Statement: [{ ...base, Condition: { StringEqualsIfExists: { 'aws:username': 'ada' } } }],
    };
    const input = { action: 's3:GetObject', resource: 'arn:aws:s3:::a/b' };

    expect(evaluatePolicy(strict, input).decision).toBe('implicit-deny');
    expect(evaluatePolicy(lenient, input).decision).toBe('allow');
  });

  it('StringLike honours wildcards', () => {
    const document: PolicyDocument = {
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: '*',
          Condition: { StringLike: { 's3:prefix': 'team-*/' } },
        },
      ],
    };
    expect(
      evaluatePolicy(document, {
        action: 's3:GetObject',
        resource: 'x',
        context: { 's3:prefix': 'team-blue/' },
      }).decision,
    ).toBe('allow');
    expect(
      evaluatePolicy(document, {
        action: 's3:GetObject',
        resource: 'x',
        context: { 's3:prefix': 'crew-blue/' },
      }).decision,
    ).toBe('implicit-deny');
  });

  it('IpAddress matches inside a CIDR and rejects outside it', () => {
    const document: PolicyDocument = {
      Statement: [
        {
          Effect: 'Deny',
          Action: 's3:*',
          Resource: '*',
          Condition: { IpAddress: { 'aws:SourceIp': ['10.0.0.0/24', '192.168.1.5'] } },
        },
      ],
    };
    const decide = (ip: string) =>
      evaluatePolicy(document, {
        action: 's3:GetObject',
        resource: 'x',
        context: { 'aws:SourceIp': ip },
      }).decision;

    expect(decide('10.0.0.7')).toBe('deny');
    expect(decide('10.0.0.255')).toBe('deny');
    expect(decide('10.0.1.7')).toBe('implicit-deny');
    expect(decide('192.168.1.5')).toBe('deny');
    expect(decide('192.168.1.6')).toBe('implicit-deny');
    expect(decide('not-an-ip')).toBe('implicit-deny');
  });

  it('IpAddress handles /0 and /32 boundaries', () => {
    const any: PolicyDocument = {
      Statement: [
        {
          Effect: 'Allow',
          Action: '*',
          Resource: '*',
          Condition: { IpAddress: { 'aws:SourceIp': '0.0.0.0/0' } },
        },
      ],
    };
    const single: PolicyDocument = {
      Statement: [
        {
          Effect: 'Allow',
          Action: '*',
          Resource: '*',
          Condition: { IpAddress: { 'aws:SourceIp': '203.0.113.9/32' } },
        },
      ],
    };
    const decide = (document: PolicyDocument, ip: string) =>
      evaluatePolicy(document, {
        action: 's3:GetObject',
        resource: 'x',
        context: { 'aws:SourceIp': ip },
      }).decision;

    expect(decide(any, '8.8.8.8')).toBe('allow');
    expect(decide(single, '203.0.113.9')).toBe('allow');
    expect(decide(single, '203.0.113.10')).toBe('implicit-deny');
  });

  it('Bool compares case-insensitively', () => {
    const document: PolicyDocument = {
      Statement: [
        {
          Effect: 'Deny',
          Action: 's3:*',
          Resource: '*',
          Condition: { Bool: { 'aws:SecureTransport': false } },
        },
      ],
    };
    expect(
      evaluatePolicy(document, {
        action: 's3:GetObject',
        resource: 'x',
        context: { 'aws:SecureTransport': 'False' },
      }).decision,
    ).toBe('deny');
    expect(
      evaluatePolicy(document, {
        action: 's3:GetObject',
        resource: 'x',
        context: { 'aws:SecureTransport': 'true' },
      }).decision,
    ).toBe('implicit-deny');
  });

  it('requires every operator and key in the block to match', () => {
    const document: PolicyDocument = {
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: '*',
          Condition: {
            StringEquals: { 'aws:username': 'ada' },
            Bool: { 'aws:SecureTransport': true },
          },
        },
      ],
    };
    expect(
      evaluatePolicy(document, {
        action: 's3:GetObject',
        resource: 'x',
        context: { 'aws:username': 'ada', 'aws:SecureTransport': 'true' },
      }).decision,
    ).toBe('allow');
    expect(
      evaluatePolicy(document, {
        action: 's3:GetObject',
        resource: 'x',
        context: { 'aws:username': 'ada', 'aws:SecureTransport': 'false' },
      }).decision,
    ).toBe('implicit-deny');
  });

  it('looks condition keys up case-insensitively', () => {
    const document: PolicyDocument = {
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: '*',
          Condition: { StringEquals: { 'AWS:UserName': 'ada' } },
        },
      ],
    };
    expect(
      evaluatePolicy(document, {
        action: 's3:GetObject',
        resource: 'x',
        context: { 'aws:username': 'ada' },
      }).decision,
    ).toBe('allow');
  });

  it('reports an operator it cannot evaluate and does not match on it', () => {
    const result = evaluatePolicy(
      {
        Statement: [
          {
            Effect: 'Allow',
            Action: 's3:GetObject',
            Resource: '*',
            Condition: { NumericLessThan: { 's3:max-keys': '10' } },
          },
        ],
      },
      { action: 's3:GetObject', resource: 'x', context: { 's3:max-keys': '5' } },
    );

    expect(result.decision).toBe('implicit-deny');
    expect(result.unsupportedOperators).toEqual(['NumericLessThan']);
  });
});

describe('validatePolicyDocument', () => {
  it('accepts a well-formed policy', () => {
    const result = validatePolicyDocument(allowGetObject);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a non-object', () => {
    const result = validatePolicyDocument('not a policy');
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain('JSON object');
  });

  it('requires Statement', () => {
    const result = validatePolicyDocument({ Version: '2012-10-17' });
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.path)).toContain('Statement');
  });

  it('rejects a bad Effect and points at it', () => {
    const result = validatePolicyDocument({
      Statement: [{ Effect: 'Maybe', Action: '*', Resource: '*' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.path)).toContain('Statement[0].Effect');
  });

  it('rejects Action together with NotAction', () => {
    const result = validatePolicyDocument({
      Statement: [{ Effect: 'Allow', Action: '*', NotAction: 's3:Get*', Resource: '*' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('both Action and NotAction'))).toBe(true);
  });

  it('rejects a duplicate Sid', () => {
    const result = validatePolicyDocument({
      Statement: [
        { Sid: 'A', Effect: 'Allow', Action: '*', Resource: '*' },
        { Sid: 'A', Effect: 'Deny', Action: '*', Resource: '*' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('Duplicate Sid'))).toBe(true);
  });

  it('warns about a wide-open Allow and a missing Version without failing', () => {
    const result = validatePolicyDocument({
      Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('warns about an operator the simulator cannot evaluate', () => {
    const result = validatePolicyDocument({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: '*',
          Condition: { DateGreaterThan: { 'aws:CurrentTime': '2026-01-01T00:00:00Z' } },
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('DateGreaterThan'))).toBe(true);
  });
});
