import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/common/errors/domain.exception';
import {
  basename,
  copySource,
  decodeCursor,
  encodeCursor,
  objectErrorMessage,
} from '../../src/modules/objects/objects.service';
import {
  basenameOf,
  contentDisposition,
  encodeTagging,
  stripQuotes,
} from '../../src/modules/objects/object-stream.service';
import { parseTagHeader } from '../../src/modules/objects/objects.controller';
import { isBlocked } from '../../src/modules/objects/url-import';

describe('copySource', () => {
  it('encodes each segment but keeps the slashes', () => {
    // Encoding the whole string turns a key with a slash into a key with %2F in
    // its name, and the copy silently lands somewhere else.
    expect(copySource('reports', 'q1/summary.pdf')).toBe('reports/q1/summary.pdf');
  });

  it('encodes the characters that would otherwise change the request', () => {
    expect(copySource('reports', 'a b.txt')).toBe('reports/a%20b.txt');
    expect(copySource('reports', 'a?b.txt')).toBe('reports/a%3Fb.txt');
    expect(copySource('reports', 'a#b.txt')).toBe('reports/a%23b.txt');
    expect(copySource('reports', '100%.txt')).toBe('reports/100%25.txt');
  });

  it('encodes non-ASCII keys', () => {
    expect(copySource('reports', 'گزارش.pdf')).toBe(`reports/${encodeURIComponent('گزارش.pdf')}`);
  });
});

describe('the list cursor', () => {
  it('round-trips a continuation token', () => {
    expect(decodeCursor(encodeCursor({ token: 'abc/def+ghi=' }))).toEqual({
      token: 'abc/def+ghi=',
    });
  });

  it('round-trips both version markers', () => {
    const cursor = { keyMarker: 'a/b.txt', versionMarker: 'v1' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is url-safe, so it survives a query string untouched', () => {
    const encoded = encodeCursor({ token: 'a+b/c=d' });
    expect(encoded).toBe(encodeURIComponent(encoded));
  });

  it('rejects a cursor this API did not issue', () => {
    expect(() => decodeCursor('not-base64-json')).toThrow(ValidationError);
    expect(() => decodeCursor(Buffer.from('"a string"').toString('base64url'))).toThrow(
      ValidationError,
    );
  });
});

describe('encodeTagging', () => {
  it('writes the URL-encoded query string S3 expects, not JSON', () => {
    expect(encodeTagging({ stage: 'archive', owner: 'team a' })).toBe('stage=archive&owner=team+a');
  });

  it('is empty for no tags', () => {
    expect(encodeTagging({})).toBe('');
  });
});

describe('parseTagHeader', () => {
  it('reads the same spelling encodeTagging writes', () => {
    expect(parseTagHeader('stage=archive&owner=team+a')).toEqual({
      stage: 'archive',
      owner: 'team a',
    });
  });

  it('is empty for an absent header', () => {
    expect(parseTagHeader(null)).toEqual({});
  });
});

describe('contentDisposition', () => {
  it('sets attachment or inline as asked', () => {
    expect(contentDisposition(false, 'a.pdf')).toContain('attachment;');
    expect(contentDisposition(true, 'a.pdf')).toContain('inline;');
  });

  it('always carries an RFC 5987 encoded name as well as an ASCII one', () => {
    const header = contentDisposition(false, 'گزارش.pdf');
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('گزارش.pdf')}`);
    expect(header).toMatch(/filename="[\x20-\x7e]*"/);
  });

  it('neutralises a quote or a newline in the key', () => {
    // An unencoded filename here is both a broken download and a response-splitting
    // opportunity, because an object key is caller-controlled.
    const header = contentDisposition(false, 'evil"\r\nX-Injected: 1.txt');
    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header.split('filename*=')[0]).not.toContain('evil"');
  });
});

describe('basename', () => {
  it('takes the last segment', () => {
    expect(basename('a/b/c.txt')).toBe('c.txt');
    expect(basenameOf('a/b/c.txt')).toBe('c.txt');
  });

  it('ignores a trailing slash, as a folder key has', () => {
    expect(basename('a/b/')).toBe('b');
  });

  it('returns the key itself when there is no slash', () => {
    expect(basename('c.txt')).toBe('c.txt');
  });
});

describe('stripQuotes', () => {
  it('unwraps the quoted ETag S3 returns', () => {
    expect(stripQuotes('"d41d8cd98f00b204e9800998ecf8427e"')).toBe(
      'd41d8cd98f00b204e9800998ecf8427e',
    );
  });

  it('leaves an unquoted ETag alone', () => {
    expect(stripQuotes('abc-1')).toBe('abc-1');
  });
});

describe('objectErrorMessage', () => {
  it('keeps a domain error’s own wording, which is already caller-safe', () => {
    expect(objectErrorMessage(new ValidationError('the key is not allowed'))).toBe(
      'the key is not allowed',
    );
  });

  it('strips the endpoint and paths out of a provider message', () => {
    const message = objectErrorMessage(
      new Error('PUT http://10.1.2.3:9000/bucket/key failed at /data/disk1/x'),
    );
    expect(message).not.toContain('10.1.2.3');
    expect(message).not.toContain('/data/disk1');
  });

  it('has a sentence for something that is not an Error at all', () => {
    expect(objectErrorMessage('oops')).toBe('The operation failed.');
  });
});

describe('the import-url destination guard', () => {
  it('blocks loopback', () => {
    expect(isBlocked('127.0.0.1')).toBe(true);
    expect(isBlocked('127.1.2.3')).toBe(true);
    expect(isBlocked('::1')).toBe(true);
    expect(isBlocked('::ffff:127.0.0.1')).toBe(true);
  });

  it('blocks the unspecified address', () => {
    expect(isBlocked('0.0.0.0')).toBe(true);
    expect(isBlocked('::')).toBe(true);
  });

  it('blocks link-local, which is where cloud metadata lives', () => {
    expect(isBlocked('169.254.169.254')).toBe(true);
    expect(isBlocked('fe80::1')).toBe(true);
    expect(isBlocked('FE80::1')).toBe(true);
  });

  it('allows private ranges, because this console lives on the operator’s LAN', () => {
    // Refusing 10/8 would make importing from an internal host impossible, which
    // is the normal case for an on-premise install.
    expect(isBlocked('10.1.2.3')).toBe(false);
    expect(isBlocked('192.168.1.10')).toBe(false);
    expect(isBlocked('172.16.0.5')).toBe(false);
  });

  it('allows a public address', () => {
    expect(isBlocked('93.184.216.34')).toBe(false);
    expect(isBlocked('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });
});
