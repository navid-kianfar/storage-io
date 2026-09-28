import { evaluatePolicy, validatePolicyDocument } from '@storage-io/contracts';
import { describe, expect, it } from 'vitest';
import {
  POLICY_TEMPLATES,
  asList,
  statementsOf,
  templateDocument,
  withStatements,
} from './policyTemplates';

/**
 * The templates are what most policies in an installation start from, so they are
 * checked against the same validator and the same evaluator the API uses — not
 * against a snapshot of their own JSON, which would only prove they have not
 * changed.
 */

describe('templateDocument', () => {
  it('produces a document the shared validator accepts', () => {
    for (const template of POLICY_TEMPLATES) {
      const result = validatePolicyDocument(templateDocument(template, 'media-prod'));
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  it('writes the chosen bucket into the resources, not a placeholder', () => {
    const document = JSON.stringify(templateDocument('read-only', 'media-prod'));
    expect(document).toContain('arn:aws:s3:::media-prod');
    expect(document).not.toContain('bucket-name');
  });

  it('read-only allows a GET and does not allow a PUT', () => {
    const document = templateDocument('read-only', 'media-prod');
    expect(
      evaluatePolicy(document, {
        action: 's3:GetObject',
        resource: 'arn:aws:s3:::media-prod/a.jpg',
      }).decision,
    ).toBe('allow');
    expect(
      evaluatePolicy(document, {
        action: 's3:PutObject',
        resource: 'arn:aws:s3:::media-prod/a.jpg',
      }).decision,
    ).toBe('implicit-deny');
  });

  it('upload-only denies reads outright rather than merely not allowing them', () => {
    const document = templateDocument('upload-only', 'media-prod');
    expect(
      evaluatePolicy(document, {
        action: 's3:PutObject',
        resource: 'arn:aws:s3:::media-prod/a.jpg',
      }).decision,
    ).toBe('allow');
    expect(
      evaluatePolicy(document, {
        action: 's3:GetObject',
        resource: 'arn:aws:s3:::media-prod/a.jpg',
      }).decision,
    ).toBe('deny');
  });

  it('grants nothing outside the chosen bucket', () => {
    const document = templateDocument('read-write', 'media-prod');
    expect(
      evaluatePolicy(document, {
        action: 's3:GetObject',
        resource: 'arn:aws:s3:::other-bucket/a.jpg',
      }).decision,
    ).toBe('implicit-deny');
  });
});

describe('statementsOf', () => {
  it('reads both the array and the single-object form', () => {
    expect(statementsOf({ Statement: [{ Effect: 'Allow' }] })).toHaveLength(1);
    expect(statementsOf({ Statement: { Effect: 'Allow' } })).toHaveLength(1);
  });

  it('is empty for anything that is not a document', () => {
    expect(statementsOf(null)).toEqual([]);
    expect(statementsOf('nope')).toEqual([]);
    expect(statementsOf({})).toEqual([]);
  });
});

describe('withStatements', () => {
  it('keeps the rest of the document and adds a Version when there is none', () => {
    const next = withStatements({ Id: 'keep-me' }, [{ Effect: 'Allow' }]);
    expect(next.Id).toBe('keep-me');
    expect(next.Version).toBe('2012-10-17');
    expect(next.Statement).toHaveLength(1);
  });

  it('does not overwrite an existing Version', () => {
    const next = withStatements({ Version: '2008-10-17' }, []);
    expect(next.Version).toBe('2008-10-17');
  });
});

describe('asList', () => {
  it('normalises the string / array / absent cases', () => {
    expect(asList('s3:GetObject')).toEqual(['s3:GetObject']);
    expect(asList(['a', 'b'])).toEqual(['a', 'b']);
    expect(asList(undefined)).toEqual([]);
  });
});
