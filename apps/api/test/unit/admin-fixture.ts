import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { ServerConnection } from '../../src/providers/provider-driver';

/**
 * A recorded-HTTP fixture for the two admin APIs with no container in
 * `docker/docker-compose.dev.yml`: Ceph RGW and Garage.
 *
 * A real `node:http` server rather than a request mock, on purpose. What is being
 * tested is the transport as well as the mapping — the SigV4 `Authorization` header,
 * the bare `?key` flag in the query string, the bearer token, the agent that carries
 * the per-server TLS settings. A library that intercepts the request before the
 * socket would test none of that, and the signing is exactly the part that fails
 * against a real cluster.
 */

export interface RecordedRequest {
  readonly method: string;
  /** Path and query, exactly as it went over the wire. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FixtureReply {
  readonly status?: number;
  readonly json?: unknown;
  readonly text?: string;
}

export interface AdminFixture {
  readonly baseUrl: string;
  readonly requests: readonly RecordedRequest[];
  /** Queues the reply for the next request; replies are consumed in order. */
  reply(reply: FixtureReply): void;
  close(): Promise<void>;
}

export async function startAdminFixture(): Promise<AdminFixture> {
  const queued: FixtureReply[] = [];
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((request, response) => {
    void readBody(request).then((body) => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: normalizeHeaders(request),
        body,
      });

      const reply = queued.shift() ?? { status: 200, json: {} };
      const payload =
        reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      response.end(payload);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The fixture server did not bind a port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    reply: (reply) => queued.push(reply),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** A connection pointed at the fixture, with everything else a plausible default. */
export function fixtureConnection(
  baseUrl: string,
  overrides: Partial<ServerConnection> = {},
): ServerConnection {
  return {
    id: 'server-1',
    name: 'fixture',
    provider: 'ceph',
    endpoint: baseUrl,
    region: 'us-east-1',
    accessKeyId: 'fixture-access-key',
    secretAccessKey: 'fixture-secret-key',
    adminToken: null,
    options: {
      pathStyle: true,
      tlsVerify: true,
      caPem: null,
      adminEndpoint: baseUrl,
      iamEndpoint: null,
      healthIntervalSec: 3600,
    },
    ...overrides,
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}
