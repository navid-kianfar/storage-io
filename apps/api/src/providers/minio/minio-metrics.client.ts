import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AdminHttpClient } from '../iam/admin-http.client';
import type { ServerConnection, TrafficCounters } from '../provider-driver';

/**
 * MinIO's Prometheus cluster metrics, behind the server overview's traffic chart.
 *
 * ## The bearer token
 *
 * `/minio/v2/metrics/cluster` is authenticated with a JWT rather than SigV4 —
 * the same token `mc admin prometheus generate` prints. It is HS512 over the
 * server's **secret key**, with three claims:
 *
 * ```
 * { "exp": <unix seconds>, "sub": "<access key id>", "iss": "prometheus" }
 * ```
 *
 * Minted per request and valid for a minute: it is derived from a credential
 * storage-io already holds, so caching it would only lengthen the window in which
 * a leaked one is useful. A deployment running with
 * `MINIO_PROMETHEUS_AUTH_TYPE=public` ignores the header, which costs nothing.
 *
 * **Unverified against MinIO's source**: the claim set is what `mc`'s generated
 * token carries and what the dev container accepts (see
 * `test/it/traffic.it.spec.ts`). A release that adds a required claim would come
 * back 403, which the sampler treats as "no traffic data" rather than as a
 * failure — so a wrong guess degrades the chart and nothing else.
 *
 * ## The metric names
 *
 * **MinIO caches these counters for about ten seconds.** Verified against the dev
 * container (DEVELOPMENT.2025-05-24T17-08-30Z): thirty `ListBuckets` calls did not
 * move `minio_s3_requests_total` at +0 s, +2 s or +5 s, and did at +11 s. So the
 * series is accurate over the health-check interval (30 s by default) and would be
 * meaningless if it were sampled every second — which is one more reason the
 * sampler rides the health check rather than a timer of its own.
 *
 * Parsed out of the exposition format rather than through a Prometheus client:
 * four counters, summed across every label set, because the chart wants the
 * cluster total and MinIO breaks the same counter down by API, bucket or drive
 * depending on the release. Both the current names and the pre-2022
 * `minio_s3_traffic_*_bytes_total` spellings are accepted, since an operator's
 * MinIO is whatever version they have.
 */

const METRICS_PATH = '/minio/v2/metrics/cluster';
const TOKEN_TTL_SEC = 60;
const TOKEN_ISSUER = 'prometheus';
const TOKEN_ALGORITHM = 'HS512';
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Which metric feeds each counter, most preferred first. Only the first name that
 * appears in the payload is used: summing two spellings of the same counter
 * would double it on a release that exposes both.
 */
const COUNTER_SOURCES = [
  ['requests', ['minio_s3_requests_total', 'minio_s3_requests_incoming_total']],
  ['errors', ['minio_s3_requests_errors_total', 'minio_s3_requests_4xx_errors_total']],
  ['rxBytes', ['minio_s3_traffic_received_bytes', 'minio_s3_traffic_received_bytes_total']],
  ['txBytes', ['minio_s3_traffic_sent_bytes', 'minio_s3_traffic_sent_bytes_total']],
] as const satisfies readonly (readonly [keyof TrafficCounters, readonly string[]])[];

const WANTED_METRIC_NAMES: ReadonlySet<string> = new Set(
  COUNTER_SOURCES.flatMap(([, names]) => [...names]),
);

@Injectable()
export class MinioMetricsClient {
  private readonly log = new Logger(MinioMetricsClient.name);

  constructor(private readonly http: AdminHttpClient) {}

  /**
   * The cluster counters, or `null` when the endpoint answered with none of them.
   * A transport failure is raised: the sampler decides whether an unreachable
   * metrics endpoint is worth recording, and swallowing it here would hide a
   * misconfigured `adminEndpoint` from the operator forever.
   */
  async sample(connection: ServerConnection): Promise<TrafficCounters | null> {
    const baseUrl = connection.options.adminEndpoint ?? connection.endpoint;
    const response = await this.http.request(connection, {
      method: 'GET',
      path: METRICS_PATH,
      auth: 'bearer',
      bearerToken: mintPrometheusToken(connection),
      accept: 'text/plain',
      baseUrl,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    const counters = parsePrometheusCounters(response.body.toString('utf8'));
    if (counters === null) {
      this.log.debug(
        { server: connection.name },
        'MinIO metrics endpoint answered but carried none of the traffic counters',
      );
    }
    return counters;
  }
}

/* ------------------------------ helpers --------------------------- */

const base64url = (value: Buffer | string): string =>
  Buffer.from(value).toString('base64url').replace(/=+$/, '');

export function mintPrometheusToken(connection: ServerConnection, now = new Date()): string {
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: TOKEN_ALGORITHM }));
  const payload = base64url(
    JSON.stringify({
      exp: Math.floor(now.getTime() / 1000) + TOKEN_TTL_SEC,
      sub: connection.accessKeyId,
      iss: TOKEN_ISSUER,
    }),
  );
  const signature = createHmac('sha512', connection.secretAccessKey)
    .update(`${header}.${payload}`)
    .digest('base64url')
    .replace(/=+$/, '');
  return `${header}.${payload}.${signature}`;
}

/**
 * Sums each counter over every label set in the exposition text. `null` when not
 * one of the four counters appeared — which is how a non-MinIO endpoint that
 * happens to answer 200 is told apart from a quiet cluster reporting zeroes.
 */
export function parsePrometheusCounters(text: string): TrafficCounters | null {
  const perName = new Map<string, number>();

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const name = metricNameOf(line);
    if (name === null || !WANTED_METRIC_NAMES.has(name)) continue;

    const value = valueOf(line);
    if (value === null) continue;
    perName.set(name, (perName.get(name) ?? 0) + value);
  }

  if (perName.size === 0) return null;

  const totals: Record<keyof TrafficCounters, number> = {
    requests: 0,
    errors: 0,
    rxBytes: 0,
    txBytes: 0,
  };
  for (const [counter, names] of COUNTER_SOURCES) {
    const preferred = names.find((name) => perName.has(name));
    totals[counter] = preferred === undefined ? 0 : Math.trunc(perName.get(preferred) ?? 0);
  }
  return totals;
}

/** `name{label="x"} 1.0` and `name 1.0` both yield `name`. */
function metricNameOf(line: string): string | null {
  const end = line.search(/[{\s]/);
  if (end <= 0) return null;
  return line.slice(0, end);
}

/** The last whitespace-separated field, which is the sample value. */
function valueOf(line: string): number | null {
  const fields = line.split(/\s+/);
  const last = fields[fields.length - 1];
  if (last === undefined) return null;
  const value = Number(last);
  return Number.isFinite(value) ? value : null;
}
