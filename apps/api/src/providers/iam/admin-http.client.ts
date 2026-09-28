import { createHash } from 'node:crypto';
import { Agent as HttpAgent, request as httpRequest, type RequestOptions } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { ProviderError } from '../../common/errors/domain.exception';
import type { ServerConnection } from '../provider-driver';

/**
 * The HTTP transport the Ceph RGW and Garage admin APIs share.
 *
 * It exists for the same reason `MinioAdminClient` does: `node:http`/`node:https`
 * rather than `fetch`, so the per-server `tlsVerify` and `caPem` settings apply
 * through a real agent, which global `fetch` cannot be given without reaching
 * into undici. Agents are pooled per server and keyed by the TLS settings, so an
 * edit to them takes effect and nothing leaks a connection.
 *
 * Two authentication styles, because the two providers differ:
 *
 * - **`sigv4`** — Ceph RGW's Admin Ops API is signed exactly like an S3 request
 *   (service `s3`, the server's region, a real `x-amz-content-sha256`).
 * - **`bearer`** — Garage's admin API takes its admin token in
 *   `Authorization: Bearer`, and rejects anything else.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SIGNING_SERVICE = 's3';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

export type AdminAuth = 'sigv4' | 'bearer';

export interface AdminHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly auth: AdminAuth;
  /**
   * Query parameters. A `null` value is a valueless flag — `?key`, `?list` — which
   * both APIs use as a sub-resource selector and which `URLSearchParams` alone
   * cannot express.
   */
  readonly query?: Readonly<Record<string, string | null>>;
  readonly json?: unknown;
  readonly timeoutMs?: number;
  /** Which endpoint to use; the driver decides admin vs S3. */
  readonly baseUrl: string;
  /**
   * `auth: 'bearer'` only: a token the caller minted itself, instead of the
   * server's stored `adminToken`. MinIO's Prometheus endpoint takes a short-lived
   * JWT derived from the S3 credentials, which is not a stored secret.
   */
  readonly bearerToken?: string;
  /** Overrides the `Accept` header; Prometheus answers `text/plain`. */
  readonly accept?: string;
}

export interface AdminHttpResponse {
  readonly status: number;
  readonly body: Buffer;
}

/** A failed admin call, carrying the provider's own error code where it sent one. */
export class AdminHttpError extends ProviderError {
  constructor(
    detail: string,
    readonly httpStatus: number,
    readonly providerCode: string | null,
  ) {
    super(detail);
  }
}

interface CachedAgent {
  readonly key: string;
  readonly agent: HttpAgent | HttpsAgent;
}

@Injectable()
export class AdminHttpClient implements OnApplicationShutdown {
  private readonly logger = new Logger(AdminHttpClient.name);
  private readonly agents = new Map<string, CachedAgent>();

  async request(
    connection: ServerConnection,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const base = new URL(request.baseUrl);
    const payload =
      request.json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(request.json));

    const headers = await this.headersFor(connection, request, base, payload);
    const search = queryStringOf(request.query ?? {});
    const path = search.length > 0 ? `${request.path}?${search}` : request.path;

    const response = await this.send({
      base,
      path,
      method: request.method,
      headers,
      payload,
      agent: this.agentFor(connection, base),
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    if (response.status >= 400) throw this.failureFor(response.status, response.raw);
    return { status: response.status, body: response.raw };
  }

  /** Parses a JSON response; an empty body becomes `{}`. */
  async json<T>(connection: ServerConnection, request: AdminHttpRequest): Promise<T> {
    const response = await this.request(connection, request);
    if (response.body.length === 0) return {} as T;
    try {
      return JSON.parse(response.body.toString('utf8')) as T;
    } catch {
      throw new ProviderError('The storage server returned a body that is not JSON.');
    }
  }

  evict(serverId: string): void {
    const cached = this.agents.get(serverId);
    if (cached === undefined) return;
    cached.agent.destroy();
    this.agents.delete(serverId);
  }

  evictAll(): void {
    for (const { agent } of this.agents.values()) agent.destroy();
    this.agents.clear();
  }

  onApplicationShutdown(): void {
    this.evictAll();
  }

  private async headersFor(
    connection: ServerConnection,
    request: AdminHttpRequest,
    base: URL,
    payload: Buffer,
  ): Promise<Record<string, string>> {
    const host = base.port.length > 0 ? `${base.hostname}:${base.port}` : base.hostname;

    if (request.auth === 'bearer') {
      const token = request.bearerToken ?? connection.adminToken;
      if (token === null || token.length === 0) {
        throw new ProviderError('This server has no admin token, so its admin API cannot be used.');
      }
      const headers: Record<string, string> = { host, authorization: `Bearer ${token}` };
      if (request.accept !== undefined) headers['accept'] = request.accept;
      if (payload.length > 0) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(payload.length);
      }
      return headers;
    }

    return this.signSigV4(connection, request, base, payload, host);
  }

  private async signSigV4(
    connection: ServerConnection,
    request: AdminHttpRequest,
    base: URL,
    payload: Buffer,
    host: string,
  ): Promise<Record<string, string>> {
    const signer = new SignatureV4({
      service: SIGNING_SERVICE,
      region: connection.region,
      credentials: {
        accessKeyId: connection.accessKeyId,
        secretAccessKey: connection.secretAccessKey,
      },
      sha256: Sha256,
      // S3 signing does not re-escape the path, and RGW verifies it that way.
      uriEscapePath: false,
      applyChecksum: true,
    });

    const payloadHash =
      payload.length === 0 ? EMPTY_SHA256 : createHash('sha256').update(payload).digest('hex');

    const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash };
    if (payload.length > 0) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }

    const signed = await signer.sign(
      new HttpRequest({
        method: request.method,
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port.length > 0 ? Number(base.port) : undefined,
        path: request.path,
        // A valueless flag signs as an empty value, which is what RGW expects.
        query: signableQuery(request.query ?? {}),
        headers,
        body: payload.length > 0 ? payload : undefined,
      }),
    );

    return signed.headers;
  }

  private agentFor(connection: ServerConnection, base: URL): HttpAgent | HttpsAgent {
    const isHttps = base.protocol === 'https:';
    const { options } = connection;
    const key = [
      isHttps ? 'https' : 'http',
      base.host,
      options.tlsVerify ? 'verify' : 'noverify',
      options.caPem === null ? 'nocap' : `ca:${options.caPem.length}`,
    ].join('|');

    const cached = this.agents.get(connection.id);
    if (cached !== undefined && cached.key === key) return cached.agent;
    if (cached !== undefined) cached.agent.destroy();

    const agent = isHttps
      ? new HttpsAgent({
          keepAlive: true,
          rejectUnauthorized: options.tlsVerify,
          ...(options.caPem === null ? {} : { ca: options.caPem }),
        })
      : new HttpAgent({ keepAlive: true });

    this.agents.set(connection.id, { key, agent });
    return agent;
  }

  private send(input: {
    readonly base: URL;
    readonly path: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly payload: Buffer;
    readonly agent: HttpAgent | HttpsAgent;
    readonly timeoutMs: number;
  }): Promise<{ status: number; raw: Buffer }> {
    const isHttps = input.base.protocol === 'https:';
    const send = isHttps ? httpsRequest : httpRequest;

    const requestOptions: RequestOptions = {
      protocol: input.base.protocol,
      hostname: input.base.hostname,
      port: input.base.port.length > 0 ? Number(input.base.port) : isHttps ? 443 : 80,
      path: input.path,
      method: input.method,
      headers: input.headers,
      agent: input.agent,
      timeout: input.timeoutMs,
    };

    return new Promise((resolve, reject) => {
      const request = send(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;

        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) {
            request.destroy(new ProviderError('The admin API response was too large.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, raw: Buffer.concat(chunks) });
        });
        response.on('error', reject);
      });

      request.on('timeout', () => {
        request.destroy(new ProviderError('The admin API did not respond in time.'));
      });
      request.on('error', reject);

      if (input.payload.length > 0) request.write(input.payload);
      request.end();
    });
  }

  /** Keeps the provider's error body out of the response handed to a client. */
  private failureFor(status: number, raw: Buffer): AdminHttpError {
    const text = raw.toString('utf8');
    const code = extractCode(text);
    this.logger.warn({ status, code, body: text.slice(0, 500) }, 'Admin API error');

    if (code !== null) return new AdminHttpError(`Admin API error: ${code}.`, status, code);
    if (status === 401 || status === 403) {
      return new AdminHttpError(
        "The storage server rejected storage-io's admin credentials.",
        status,
        null,
      );
    }
    if (status === 404) {
      return new AdminHttpError('The admin API does not offer this operation.', status, null);
    }
    return new AdminHttpError(`The admin API returned HTTP ${status}.`, status, null);
  }
}

/* ------------------------------ helpers --------------------------- */

/**
 * `?key&uid=x` — a valueless flag followed by ordinary parameters. Both admin
 * APIs use flags as sub-resource selectors, so the flag is emitted bare rather
 * than as `key=`.
 */
export function queryStringOf(query: Readonly<Record<string, string | null>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === null) {
      parts.push(encodeURIComponent(key));
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join('&');
}

/** SigV4 canonicalisation wants a flag as an empty-valued parameter. */
function signableQuery(query: Readonly<Record<string, string | null>>): Record<string, string> {
  const signable: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) signable[key] = value ?? '';
  return signable;
}

/** RGW answers `{"Code":"NoSuchUser"}`; Garage answers `{"code":"..."}`. */
function extractCode(text: string): string | null {
  const xml = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
  if (xml !== undefined) return xml;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const shape = parsed as { Code?: unknown; code?: unknown };
    if (typeof shape.Code === 'string') return shape.Code;
    if (typeof shape.code === 'string') return shape.code;
  } catch {
    // Not JSON; the caller falls back to the status code.
  }
  return null;
}
