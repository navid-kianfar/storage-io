import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SERVER_OPTION_DEFAULTS } from '@storage-io/contracts';
import {
  mintPrometheusToken,
  parsePrometheusCounters,
} from '../../src/providers/minio/minio-metrics.client';
import { SKIP_SAMPLE, ratesBetween } from '../../src/servers/traffic-sampler.service';
import { cacheControlFor, isFingerprinted } from '../../src/web/web-static.module';
import type { ServerConnection } from '../../src/providers/provider-driver';
import type { MetricsTrafficRow } from '../../src/db/schema';

/**
 * The traffic chart's two halves: reading MinIO's Prometheus text, and turning two
 * readings of a cumulative counter into a rate. Both are pure, and both are where a
 * wrong answer would show up as a plausible-looking but false chart.
 */

const connection: ServerConnection = {
  id: 'srv-1',
  name: 'minio-lab',
  provider: 'minio',
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  accessKeyId: 'AKIA-LAB',
  secretAccessKey: 'the-secret',
  adminToken: null,
  options: SERVER_OPTION_DEFAULTS,
};

describe('mintPrometheusToken', () => {
  it('is an HS512 JWT over the secret key with the three claims MinIO expects', () => {
    const now = new Date('2026-03-15T10:00:00.000Z');
    const token = mintPrometheusToken(connection, now);
    const [header, payload, signature] = token.split('.');
    expect(header).toBeDefined();
    expect(payload).toBeDefined();

    expect(JSON.parse(Buffer.from(header as string, 'base64url').toString('utf8'))).toEqual({
      typ: 'JWT',
      alg: 'HS512',
    });
    expect(JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'))).toEqual({
      exp: Math.floor(now.getTime() / 1000) + 60,
      sub: 'AKIA-LAB',
      iss: 'prometheus',
    });

    const expected = createHmac('sha512', connection.secretAccessKey)
      .update(`${header as string}.${payload as string}`)
      .digest('base64url')
      .replace(/=+$/, '');
    expect(signature).toBe(expected);
  });

  it('carries no padding, so it is a valid compact JWT', () => {
    expect(mintPrometheusToken(connection)).not.toContain('=');
  });
});

describe('parsePrometheusCounters', () => {
  it('sums a counter across every label set', () => {
    const text = [
      '# HELP minio_s3_requests_total Total requests',
      '# TYPE minio_s3_requests_total counter',
      'minio_s3_requests_total{api="GetObject",server="a"} 10',
      'minio_s3_requests_total{api="PutObject",server="a"} 5',
      'minio_s3_requests_errors_total{api="GetObject"} 2',
      'minio_s3_traffic_received_bytes 1024',
      'minio_s3_traffic_sent_bytes 4096',
    ].join('\n');

    expect(parsePrometheusCounters(text)).toEqual({
      requests: 15,
      errors: 2,
      rxBytes: 1024,
      txBytes: 4096,
    });
  });

  it('prefers one spelling and never sums two names for the same counter', () => {
    // A release that exposes both `…_bytes` and `…_bytes_total` must not double the
    // traffic figure.
    const text = [
      'minio_s3_traffic_sent_bytes 100',
      'minio_s3_traffic_sent_bytes_total 100',
      'minio_s3_requests_total 1',
    ].join('\n');
    expect(parsePrometheusCounters(text)?.txBytes).toBe(100);
  });

  it('falls back to an older spelling when the preferred one is absent', () => {
    const text = ['minio_s3_traffic_sent_bytes_total 250', 'minio_s3_requests_total 1'].join('\n');
    expect(parsePrometheusCounters(text)?.txBytes).toBe(250);
  });

  it('ignores comments, blank lines and metrics it does not want', () => {
    const text = [
      '',
      '# a comment',
      'minio_node_process_cpu_total_seconds 3.5',
      'minio_s3_requests_total 7',
      '',
    ].join('\n');
    expect(parsePrometheusCounters(text)).toEqual({
      requests: 7,
      errors: 0,
      rxBytes: 0,
      txBytes: 0,
    });
  });

  it('truncates a float sample to an integer count', () => {
    expect(parsePrometheusCounters('minio_s3_requests_total 7.9')?.requests).toBe(7);
  });

  it('returns null when none of the four counters appeared', () => {
    // A non-MinIO endpoint that happens to answer 200 is not a quiet cluster.
    expect(parsePrometheusCounters('go_goroutines 42')).toBeNull();
    expect(parsePrometheusCounters('')).toBeNull();
  });

  it('skips a line whose value is not a number', () => {
    const text = ['minio_s3_requests_total NaN-ish', 'minio_s3_requests_errors_total 3'].join('\n');
    expect(parsePrometheusCounters(text)).toEqual({
      requests: 0,
      errors: 3,
      rxBytes: 0,
      txBytes: 0,
    });
  });
});

describe('ratesBetween', () => {
  const previous = (overrides: Partial<MetricsTrafficRow> = {}): MetricsTrafficRow => ({
    id: 1,
    serverId: 'srv-1',
    at: '2026-03-15T10:00:00.000Z',
    requests: 100,
    errors: 4,
    rxBytes: 1000,
    txBytes: 2000,
    requestsPerSec: null,
    errorsPerSec: null,
    rxBytesPerSec: null,
    txBytesPerSec: null,
    ...overrides,
  });

  const nowMs = Date.parse('2026-03-15T10:00:10.000Z');

  it('has no rate for the first sample of a series', () => {
    expect(ratesBetween(null, { requests: 1, errors: 0, rxBytes: 0, txBytes: 0 }, nowMs)).toEqual({
      requestsPerSec: null,
      errorsPerSec: null,
      rxBytesPerSec: null,
      txBytesPerSec: null,
    });
  });

  it('divides the delta by the elapsed seconds', () => {
    const rates = ratesBetween(
      previous(),
      { requests: 200, errors: 6, rxBytes: 11_000, txBytes: 2000 },
      nowMs,
    );
    expect(rates).toEqual({
      requestsPerSec: 10,
      errorsPerSec: 0.2,
      rxBytesPerSec: 1000,
      txBytesPerSec: 0,
    });
  });

  it('records the counters with no rate when one went backwards', () => {
    // The storage server restarted; the delta is meaningless and a spike would be
    // a lie. The series re-bases from here.
    const rates = ratesBetween(
      previous(),
      { requests: 5, errors: 0, rxBytes: 10, txBytes: 20 },
      nowMs,
    );
    expect(rates).toEqual({
      requestsPerSec: null,
      errorsPerSec: null,
      rxBytesPerSec: null,
      txBytesPerSec: null,
    });
  });

  it('skips a sample taken less than a second after the last one', () => {
    const rates = ratesBetween(
      previous(),
      { requests: 101, errors: 4, rxBytes: 1000, txBytes: 2000 },
      Date.parse('2026-03-15T10:00:00.500Z'),
    );
    expect(rates).toBe(SKIP_SAMPLE);
  });

  it('skips a sample whose previous timestamp cannot be read', () => {
    expect(
      ratesBetween(
        previous({ at: 'not a date' }),
        { requests: 1, errors: 0, rxBytes: 0, txBytes: 0 },
        nowMs,
      ),
    ).toBe(SKIP_SAMPLE);
  });
});

describe('static asset cache headers', () => {
  it('never caches index.html', () => {
    expect(cacheControlFor('/app/public/index.html')).toBe('no-cache');
  });

  it('caches a fingerprinted asset for a year, immutably', () => {
    expect(cacheControlFor('/app/public/assets/index-a1b2c3d4.js')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(cacheControlFor('/app/public/assets/main-DEADBEEF01.css')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('gives an unfingerprinted file a short cache, not an immutable one', () => {
    // `favicon.ico` and `robots.txt` change in place on a deploy.
    expect(cacheControlFor('/app/public/favicon.ico')).toBe('public, max-age=3600');
    expect(isFingerprinted('/app/public/favicon.ico')).toBe(false);
    expect(isFingerprinted('/app/public/logo-v2.png')).toBe(false);
  });
});
