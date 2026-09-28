import { createHash } from 'node:crypto';
import { Agent as HttpAgent, request as httpRequest, type RequestOptions } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Injectable, Logger } from '@nestjs/common';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { ProviderError } from '../../common/errors/domain.exception';
import type { ServerConnection } from '../provider-driver';
import { isMadminEncrypted, madminDecrypt, madminEncrypt } from './madmin-crypto';

/**
 * Transport for the MinIO Admin API v3.
 *
 * Two things make it unlike an ordinary REST client:
 *
 * 1. **SigV4 with service `s3`.** The admin API is signed exactly like an S3
 *    request — `mc`/madmin use the `s3` service name and the server's region —
 *    and `x-amz-content-sha256` must be the real body hash, not
 *    `UNSIGNED-PAYLOAD`.
 * 2. **madmin envelopes.** Several endpoints answer with, and a few expect, a
 *    body encrypted under the secret key (see `madmin-crypto.ts`). Whether a
 *    response is encrypted is decided by sniffing the algorithm byte rather than
 *    from a table of endpoints, because MinIO has changed which endpoints encrypt
 *    between releases.
 *
 * It uses `node:http`/`node:https` rather than `fetch` so the per-server TLS
 * settings (`tlsVerify`, `caPem`) apply through a real agent. Global `fetch`
 * cannot be given one without reaching into undici.
 *
 * Verified against MinIO DEVELOPMENT.2025-05-24T17-08-30Z: `info` answers plain
 * JSON, `list-users` answers a madmin AES-256-GCM envelope, and `add-user`
 * accepts a body this client encrypted.
 */

const ADMIN_PREFIX = '/minio/admin/v3';
const SIGNING_SERVICE = 's3';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

export interface AdminRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly query?: Readonly<Record<string, string>>;
  /** Sent as-is. Use `encryptedBody` when MinIO expects a madmin envelope. */
  readonly body?: Buffer;
  /** Encrypted under the secret key before sending. */
  readonly encryptedBody?: Buffer;
  readonly timeoutMs?: number;
}

export interface AdminResponse {
  readonly status: number;
  /** Decrypted when the response carried a madmin envelope. */
  readonly body: Buffer;
  readonly wasEncrypted: boolean;
}

interface CachedAgent {
  readonly key: string;
  readonly agent: HttpAgent | HttpsAgent;
}

@Injectable()
export class MinioAdminClient {
  private readonly logger = new Logger(MinioAdminClient.name);
  private readonly agents = new Map<string, CachedAgent>();

  /**
   * `adminEndpoint` when the operator set one, otherwise the S3 endpoint —
   * MinIO serves the admin API on the same port, which is why it is optional.
   */
  baseUrlFor(connection: ServerConnection): string {
    return connection.options.adminEndpoint ?? connection.endpoint;
  }

  async request(
    connection: ServerConnection,
    path: string,
    options: AdminRequestOptions = {},
  ): Promise<AdminResponse> {
    const method = options.method ?? 'GET';
    const fullPath = `${ADMIN_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
    const query = options.query ?? {};
    const payload = await this.payloadFor(connection, options);
    const base = new URL(this.baseUrlFor(connection));

    const headers = await this.sign(connection, { method, base, path: fullPath, query, payload });
    const search = new URLSearchParams(query).toString();

    const { status, raw } = await this.send({
      base,
      path: search.length > 0 ? `${fullPath}?${search}` : fullPath,
      method,
      headers,
      payload,
      agent: this.agentFor(connection, base),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    if (status >= 400) throw new ProviderError(this.describeFailure(status, raw));

    if (isMadminEncrypted(raw)) {
      const body = await madminDecrypt(connection.secretAccessKey, raw);
      return { status, body, wasEncrypted: true };
    }
    return { status, body: raw, wasEncrypted: false };
  }

  /** Parses a JSON response, encrypted or not. */
  async json<T>(
    connection: ServerConnection,
    path: string,
    options: AdminRequestOptions = {},
  ): Promise<T> {
    const response = await this.request(connection, path, options);
    if (response.body.length === 0) return {} as T;
    try {
      return JSON.parse(response.body.toString('utf8')) as T;
    } catch {
      throw new ProviderError('The MinIO admin API returned a body that is not JSON.');
    }
  }

  /** Called when a server is removed or its connection settings change. */
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

  private async payloadFor(
    connection: ServerConnection,
    options: AdminRequestOptions,
  ): Promise<Buffer> {
    if (options.encryptedBody !== undefined) {
      return madminEncrypt(connection.secretAccessKey, options.encryptedBody);
    }
    return options.body ?? Buffer.alloc(0);
  }

  private async sign(
    connection: ServerConnection,
    request: {
      readonly method: string;
      readonly base: URL;
      readonly path: string;
      readonly query: Readonly<Record<string, string>>;
      readonly payload: Buffer;
    },
  ): Promise<Record<string, string>> {
    const signer = new SignatureV4({
      service: SIGNING_SERVICE,
      region: connection.region,
      credentials: {
        accessKeyId: connection.accessKeyId,
        secretAccessKey: connection.secretAccessKey,
      },
      sha256: Sha256,
      // S3 signing does not re-escape the path; matching mc's behaviour here
      // avoids a class of signature mismatch on unusual names.
      uriEscapePath: false,
      applyChecksum: true,
    });

    const host =
      request.base.port.length > 0
        ? `${request.base.hostname}:${request.base.port}`
        : request.base.hostname;

    const payloadHash =
      request.payload.length === 0
        ? EMPTY_SHA256
        : createHash('sha256').update(request.payload).digest('hex');

    const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash };
    if (request.payload.length > 0) {
      headers['content-length'] = String(request.payload.length);
      headers['content-type'] = 'application/octet-stream';
    }

    const httpSigned = await signer.sign(
      new HttpRequest({
        method: request.method,
        protocol: request.base.protocol,
        hostname: request.base.hostname,
        port: request.base.port.length > 0 ? Number(request.base.port) : undefined,
        path: request.path,
        query: { ...request.query },
        headers,
        body: request.payload.length > 0 ? request.payload : undefined,
      }),
    );

    return httpSigned.headers;
  }

  /** One keep-alive agent per server, rebuilt when its TLS settings change. */
  private agentFor(connection: ServerConnection, base: URL): HttpAgent | HttpsAgent {
    const isHttps = base.protocol === 'https:';
    const { options } = connection;
    const key = [
      isHttps ? 'https' : 'http',
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
            request.destroy(new ProviderError('The MinIO admin API response was too large.'));
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
        request.destroy(new ProviderError('The MinIO admin API did not respond in time.'));
      });
      request.on('error', reject);

      if (input.payload.length > 0) request.write(input.payload);
      request.end();
    });
  }

  /** Keeps MinIO's XML/JSON error body out of the response we hand a client. */
  private describeFailure(status: number, raw: Buffer): string {
    const text = raw.toString('utf8');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? extractJsonCode(text);
    this.logger.warn({ status, code, body: text.slice(0, 500) }, 'MinIO admin API error');

    if (status === 403) return "MinIO rejected storage-io's admin credentials.";
    if (status === 404) return 'The MinIO admin API does not offer this operation.';
    if (code !== null && code !== undefined) return `MinIO admin API error: ${code}.`;
    return `MinIO admin API returned HTTP ${status}.`;
  }
}

function extractJsonCode(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'Code' in parsed) {
      const { Code } = parsed;
      if (typeof Code === 'string') return Code;
    }
  } catch {
    // Not JSON; the caller falls back to the status code.
  }
  return null;
}
