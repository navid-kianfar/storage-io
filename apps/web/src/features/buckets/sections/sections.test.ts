import { describe, expect, it } from 'vitest';
import { checkBucketPolicy } from './AccessSection';
import { parseCorsRules } from './CorsSection';

const POLICY_MESSAGES = {
  invalidJson: 'not json',
  notAnObject: 'not an object',
  missingStatement: 'needs a statement',
};

describe('checkBucketPolicy', () => {
  it('accepts a document with a usable Statement array', () => {
    const result = checkBucketPolicy(
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
      }),
      POLICY_MESSAGES,
    );
    expect(result).toEqual({ valid: true, message: '', statements: 1 });
  });

  it('rejects text that is not JSON at all', () => {
    expect(checkBucketPolicy('{oops', POLICY_MESSAGES).message).toBe('not json');
  });

  it('rejects an array, which is a CORS document, not a policy', () => {
    expect(checkBucketPolicy('[]', POLICY_MESSAGES).message).toBe('not an object');
  });

  it('rejects a statement without an Effect or an Action', () => {
    const body = JSON.stringify({ Statement: [{ Effect: 'Allow' }] });
    expect(checkBucketPolicy(body, POLICY_MESSAGES).message).toBe('needs a statement');
  });

  it('rejects an empty Statement array, which silently allows nothing', () => {
    expect(checkBucketPolicy('{"Statement":[]}', POLICY_MESSAGES).message).toBe(
      'needs a statement',
    );
  });
});

const CORS_MESSAGES = { invalidJson: 'not json', notAnArray: 'not an array' };

describe('parseCorsRules', () => {
  it('reads the contract’s field names and fills in what is missing', () => {
    const result = parseCorsRules(
      JSON.stringify([{ allowedOrigins: ['https://acme.com'], allowedMethods: ['GET'] }]),
      CORS_MESSAGES,
    );
    expect(result.rules).toEqual([
      {
        allowedOrigins: ['https://acme.com'],
        allowedMethods: ['GET'],
        allowedHeaders: [],
        exposeHeaders: [],
        maxAgeSeconds: null,
      },
    ]);
  });

  it('treats an empty editor as "no rules", not as an error', () => {
    expect(parseCorsRules('   ', CORS_MESSAGES).rules).toEqual([]);
  });

  it('rejects an object, because CORS is a list of rules', () => {
    expect(parseCorsRules('{}', CORS_MESSAGES).rules).toBeNull();
  });

  it('drops a non-string entry rather than sending it to the server', () => {
    const result = parseCorsRules(
      JSON.stringify([{ allowedOrigins: ['ok', 42, null] }]),
      CORS_MESSAGES,
    );
    expect(result.rules?.[0]?.allowedOrigins).toEqual(['ok']);
  });
});
