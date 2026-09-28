import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import {
  applyConnectionFieldErrors,
  connectionValuesOf,
  emptyConnectionValues,
  providerUsesAdminEndpoint,
  providerUsesAdminToken,
  toCreateServerRequest,
  toUpdateServerRequest,
} from './connection-schema';
import type { Server } from '@storage-io/contracts';

/**
 * The connection form's translation layer is where a mistake is expensive: an
 * accidentally-sent empty secret wipes a working server's credentials, and a
 * field error that lands nowhere leaves the operator with a toast and no idea
 * which input is wrong. Both are covered here.
 */

function serverFixture(overrides: Partial<Server> = {}): Server {
  return {
    id: 'srv-1',
    name: 'minio-prod-01',
    provider: 'minio',
    endpoint: 'https://s3.prod.acme.local:9000',
    region: 'us-east-1',
    status: 'healthy',
    statusDetail: null,
    latencyMs: 12,
    lastCheckedAt: null,
    lastSeenAt: null,
    version: null,
    uptime24h: 1,
    capacity: { usedBytes: 0, totalBytes: null, budget: false },
    counts: { buckets: 0, users: null, objects: null },
    capabilities: {} as Server['capabilities'],
    options: {
      pathStyle: true,
      tlsVerify: false,
      caPem: 'PEM',
      adminEndpoint: 'https://admin.local',
      iamEndpoint: null,
      healthIntervalSec: 300,
    },
    accessKeyId: 'sio-admin',
    secretMasked: '••••K7MD',
    maintenance: false,
    tls: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('connectionValuesOf', () => {
  it('never prefills the secret, because the API only returns a masked one', () => {
    const values = connectionValuesOf(serverFixture());
    expect(values.secretAccessKey).toBe('');
    expect(values.accessKeyId).toBe('sio-admin');
  });

  it('flattens the stored options, turning null into an empty field', () => {
    const values = connectionValuesOf(serverFixture());
    expect(values.tlsVerify).toBe(false);
    expect(values.caPem).toBe('PEM');
    expect(values.adminEndpoint).toBe('https://admin.local');
    expect(values.iamEndpoint).toBe('');
    expect(values.healthIntervalSec).toBe(300);
  });
});

describe('toCreateServerRequest', () => {
  it('nests the options and trims what the operator pasted', () => {
    const body = toCreateServerRequest({
      ...emptyConnectionValues('minio'),
      name: 'minio-prod-01',
      endpoint: '  https://s3.local:9000 ',
      accessKeyId: ' sio-admin ',
      secretAccessKey: 'secret-value',
      adminEndpoint: '  ',
    });
    expect(body.endpoint).toBe('https://s3.local:9000');
    expect(body.accessKeyId).toBe('sio-admin');
    // A whitespace-only advanced field means "not set", not an empty string.
    expect(body.options.adminEndpoint).toBeNull();
  });

  it('only sends an admin token when there is one', () => {
    const without = toCreateServerRequest(emptyConnectionValues('garage'));
    expect('adminToken' in without.options).toBe(false);

    const withToken = toCreateServerRequest({
      ...emptyConnectionValues('garage'),
      adminToken: 'garage-token',
    });
    expect(withToken.options.adminToken).toBe('garage-token');
  });
});

describe('toUpdateServerRequest', () => {
  it('omits the secret entirely when the field was left blank', () => {
    const body = toUpdateServerRequest(connectionValuesOf(serverFixture()));
    expect('secretAccessKey' in body).toBe(false);
  });

  it('sends the secret when the operator typed a new one', () => {
    const body = toUpdateServerRequest({
      ...connectionValuesOf(serverFixture()),
      secretAccessKey: 'rotated-value',
    });
    expect(body.secretAccessKey).toBe('rotated-value');
  });
});

describe('applyConnectionFieldErrors', () => {
  function problem(errors: readonly { path: string; message: string }[]) {
    return new ApiError({
      type: 'about:blank',
      title: 'Validation',
      status: 422,
      detail: 'Some fields need attention.',
      code: 'VALIDATION',
      errors: [...errors],
    });
  }

  it('unnests an options path so it lands on the flat form field', () => {
    const setError = vi.fn();
    const matched = applyConnectionFieldErrors(
      problem([{ path: 'options.adminEndpoint', message: 'Not a URL' }]),
      setError,
    );
    expect(matched).toBe(true);
    expect(setError).toHaveBeenCalledWith('adminEndpoint', {
      type: 'server',
      message: 'Not a URL',
    });
  });

  it('reports no match for a path the form has no field for', () => {
    const setError = vi.fn();
    const matched = applyConnectionFieldErrors(
      problem([{ path: 'somethingElse', message: 'Nope' }]),
      setError,
    );
    expect(matched).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it('ignores an error that is not an ApiError', () => {
    const setError = vi.fn();
    expect(applyConnectionFieldErrors(new Error('network'), setError)).toBe(false);
  });
});

describe('provider gating', () => {
  it('asks only Garage for an admin token', () => {
    expect(providerUsesAdminToken('garage')).toBe(true);
    expect(providerUsesAdminToken('minio')).toBe(false);
  });

  it('hides the admin endpoint for the providers with no IAM driver', () => {
    expect(providerUsesAdminEndpoint('minio')).toBe(true);
    expect(providerUsesAdminEndpoint('r2')).toBe(false);
    expect(providerUsesAdminEndpoint('generic')).toBe(false);
  });

  it('defaults path-style off for the two providers that require virtual-host', () => {
    expect(emptyConnectionValues('aws').pathStyle).toBe(false);
    expect(emptyConnectionValues('r2').pathStyle).toBe(false);
    expect(emptyConnectionValues('minio').pathStyle).toBe(true);
  });
});
