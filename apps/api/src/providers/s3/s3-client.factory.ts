import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { Injectable, Logger } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { ServerConnection } from '../provider-driver';

const CONNECTION_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Deliberately low: a storage server that needs more than two tries is down. */
const MAX_ATTEMPTS = 2;

/**
 * Builds the S3 client for a connection. Three options make this more than a
 * one-liner:
 *
 * - **path-style** is the default for every self-hosted provider; virtual-hosted
 *   style needs wildcard DNS, which a LAN install rarely has.
 * - **`tlsVerify: false`** exists because internal deployments run with
 *   self-signed certificates. It is per-server, never global, so turning it off
 *   for a lab does not weaken the connection to production.
 * - **`caPem`** is the better answer to the same problem: pin the internal CA
 *   and keep verification on.
 *
 * Clients are cached per server, keyed by the settings that shape them, because
 * each one owns a keep-alive pool: rebuilding it per request would open a new TCP
 * connection for every call.
 */
@Injectable()
export class S3ClientFactory {
  private readonly logger = new Logger(S3ClientFactory.name);
  private readonly cache = new Map<string, { key: string; client: S3Client }>();

  create(connection: ServerConnection): S3Client {
    const key = cacheKeyFor(connection);
    const cached = this.cache.get(connection.id);
    if (cached !== undefined && cached.key === key) return cached.client;

    if (cached !== undefined) {
      // The connection changed (endpoint, credentials, TLS): drop the old pool.
      cached.client.destroy();
    }

    const client = this.build(connection);
    this.cache.set(connection.id, { key, client });
    return client;
  }

  /** A client that is not cached — for `POST /servers/test` on unsaved input. */
  createTransient(connection: ServerConnection): S3Client {
    return this.build(connection);
  }

  /** Called when a server is deleted, and on shutdown. */
  evict(serverId: string): void {
    const cached = this.cache.get(serverId);
    if (cached === undefined) return;
    cached.client.destroy();
    this.cache.delete(serverId);
  }

  evictAll(): void {
    for (const { client } of this.cache.values()) client.destroy();
    this.cache.clear();
  }

  private build(connection: ServerConnection): S3Client {
    const { options } = connection;
    const isHttps = connection.endpoint.startsWith('https:');

    if (!options.tlsVerify && isHttps) {
      this.logger.warn(
        { server: connection.name },
        'TLS verification is disabled for this server; prefer pinning its CA with caPem',
      );
    }

    const requestHandler = new NodeHttpHandler({
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      httpAgent: new HttpAgent({ keepAlive: true }),
      httpsAgent: new HttpsAgent({
        keepAlive: true,
        rejectUnauthorized: options.tlsVerify,
        ...(options.caPem === null ? {} : { ca: options.caPem }),
      }),
    });

    return new S3Client({
      endpoint: connection.endpoint,
      region: connection.region,
      forcePathStyle: options.pathStyle,
      credentials: {
        accessKeyId: connection.accessKeyId,
        secretAccessKey: connection.secretAccessKey,
      },
      maxAttempts: MAX_ATTEMPTS,
      requestHandler,
    });
  }
}

/**
 * Everything that changes the client's behaviour. The secret is hashed into the
 * key by length and last characters rather than included, so the cache key is
 * never a place a credential sits in a heap dump.
 */
function cacheKeyFor(connection: ServerConnection): string {
  const { options } = connection;
  return [
    connection.endpoint,
    connection.region,
    connection.accessKeyId,
    `${connection.secretAccessKey.length}:${connection.secretAccessKey.slice(-4)}`,
    options.pathStyle ? 'path' : 'vhost',
    options.tlsVerify ? 'verify' : 'noverify',
    options.caPem === null ? 'nocap' : `ca:${options.caPem.length}`,
  ].join('|');
}
