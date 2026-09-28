import { describe, expect, it } from 'vitest';
import {
  mapProviderError,
  sanitizeProviderMessage,
} from '../../src/common/errors/provider-error.mapper';

/** An AWS SDK service exception, as the client actually throws it. */
const sdkError = (name: string, message = 'something went wrong', httpStatusCode = 400): Error => {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, { $metadata: { httpStatusCode } });
  return error;
};

/** A transport failure, with the syscall code where undici puts it. */
const transportError = (code: string, nested = false): Error => {
  const error = new Error('fetch failed');
  if (nested) {
    const cause = new Error('connect failed');
    Object.assign(cause, { code });
    Object.assign(error, { cause });
  } else {
    Object.assign(error, { code });
  }
  return error;
};

describe('mapProviderError — classification', () => {
  it('maps the missing-resource family to NOT_FOUND', () => {
    for (const name of ['NoSuchBucket', 'NoSuchKey', 'NotFound', 'NoSuchEntity']) {
      expect(mapProviderError(sdkError(name, 'gone', 404)), name).toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    }
  });

  it('maps already-exists to CONFLICT', () => {
    expect(mapProviderError(sdkError('BucketAlreadyOwnedByYou'))).toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
  });

  it('maps BucketNotEmpty to its own code', () => {
    const mapped = mapProviderError(sdkError('BucketNotEmpty'));
    expect(mapped).toMatchObject({ code: 'BUCKET_NOT_EMPTY', status: 409 });
    expect(mapped?.detail).toBe('The bucket still contains objects.');
  });

  it('maps NotImplemented to NOT_SUPPORTED', () => {
    expect(mapProviderError(sdkError('NotImplemented'))).toMatchObject({
      code: 'NOT_SUPPORTED',
      status: 409,
    });
  });

  it('maps a credential rejection to PROVIDER_ERROR without echoing the reason', () => {
    const mapped = mapProviderError(
      sdkError('SignatureDoesNotMatch', 'The request signature...', 403),
    );
    expect(mapped).toMatchObject({ code: 'PROVIDER_ERROR', status: 502 });
    expect(mapped?.detail).toBe("The storage server rejected storage-io's credentials.");
  });

  it('maps a transport failure to SERVER_OFFLINE', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(mapProviderError(transportError(code)), code).toMatchObject({
        code: 'SERVER_OFFLINE',
        status: 503,
      });
    }
  });

  it('finds the syscall code through a cause chain', () => {
    // undici wraps the real code one level down; missing it would mislabel every
    // unreachable server as a provider error.
    expect(mapProviderError(transportError('ECONNREFUSED', true))).toMatchObject({
      code: 'SERVER_OFFLINE',
    });
  });

  it('gives a TLS failure a message that names the fix', () => {
    const mapped = mapProviderError(transportError('DEPTH_ZERO_SELF_SIGNED_CERT'));
    expect(mapped?.code).toBe('SERVER_OFFLINE');
    expect(mapped?.detail).toMatch(/CA certificate|TLS verification/);
  });

  it('treats any CERT_* code as a TLS failure', () => {
    expect(mapProviderError(transportError('CERT_HAS_EXPIRED'))?.detail).toMatch(/TLS handshake/);
  });

  it('falls back to PROVIDER_ERROR for an unknown name that reached the server', () => {
    expect(mapProviderError(sdkError('SomeFutureMinioError', 'odd', 500))).toMatchObject({
      code: 'PROVIDER_ERROR',
      status: 502,
    });
  });

  it('returns null for an error that is not a provider failure at all', () => {
    // A bug in our own code must not be reported as the provider's fault.
    expect(mapProviderError(new TypeError('cannot read property of undefined'))).toBeNull();
    expect(mapProviderError('a string')).toBeNull();
    expect(mapProviderError(null)).toBeNull();
  });
});

describe('sanitizeProviderMessage', () => {
  it('removes endpoints, addresses and filesystem paths', () => {
    expect(sanitizeProviderMessage('failed to reach https://minio.internal:9000/bucket')).toBe(
      'failed to reach [endpoint]',
    );
    expect(sanitizeProviderMessage('node 10.0.5.17:9000 is down')).toContain('[address]');
    expect(sanitizeProviderMessage('drive /mnt/data/disk1/xl.meta is unreadable')).toContain(
      '[path]',
    );
  });

  it('keeps the part that says what went wrong', () => {
    expect(sanitizeProviderMessage('The specified bucket does not exist')).toBe(
      'The specified bucket does not exist',
    );
  });

  it('collapses whitespace and truncates a long message', () => {
    expect(sanitizeProviderMessage('a\n  b\t c')).toBe('a b c');
    const long = sanitizeProviderMessage('x'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('…')).toBe(true);
  });

  it('never leaks an endpoint through a mapped detail', () => {
    const mapped = mapProviderError(
      sdkError('SomeError', 'could not reach https://internal-minio.corp:9000/secret-bucket', 500),
    );
    expect(mapped?.detail).not.toContain('internal-minio');
    expect(mapped?.detail).not.toContain('secret-bucket');
  });
});
