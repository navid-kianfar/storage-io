import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchImportUrl, isBlocked, type HostResolver } from '../../src/modules/objects/url-import';

/**
 * `POST …/objects/import-url` is the one endpoint that makes the API dial an
 * address the caller chose, so its fence is worth asserting from the outside.
 *
 * The DNS rebinding case is the one that needed fixing: the check resolved the
 * name and then handed the **name** to `fetch`, which resolved it again. A record
 * with a one-second TTL answers a public address for the check and the metadata
 * service for the connection, and nothing in between ever noticed.
 *
 * A stub resolver stands in for that record — a safe answer first and a blocked
 * one after it. Code that resolves once and connects to the vetted address never
 * sees the second answer, which is exactly what these cases assert.
 */

const LIMIT_BYTES = 10 * 1024 * 1024;
const SAFE_HOST = 'import.example.invalid';
const METADATA_HOST = 'metadata.example.invalid';
const METADATA_ADDRESS = '169.254.169.254';

/**
 * The machine's own private address.
 *
 * The fence blocks loopback and allows private ranges — that asymmetry is
 * deliberate (see `fetchImportUrl`) and it is also what makes a local stub server
 * reachable through the fence at all. Without such an interface the cases that
 * need a live connection are skipped rather than made to pass some other way.
 */
const privateAddress = ((): string | null => {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (!isBlocked(entry.address)) return entry.address;
    }
  }
  return null;
})();

describe('isBlocked', () => {
  it('refuses loopback, link-local and the unspecified address', () => {
    for (const address of [
      '127.0.0.1',
      '127.9.9.9',
      '0.0.0.0',
      '::',
      '::1',
      METADATA_ADDRESS,
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isBlocked(address)).toBe(true);
    }
  });

  it('allows a private network, which is the whole point of an on-premise console', () => {
    for (const address of ['10.1.2.3', '192.168.0.5', '172.16.0.1', '93.184.216.34']) {
      expect(isBlocked(address)).toBe(false);
    }
  });
});

describe('fetchImportUrl', () => {
  let server: Server | null = null;
  /** The `Host` header each request arrived with, in order. */
  let seenHosts: string[] = [];

  afterEach(async () => {
    const running = server;
    server = null;
    seenHosts = [];
    if (running === null) return;
    await new Promise<void>((resolve) => running.close(() => resolve()));
  });

  interface Answer {
    readonly status: number;
    readonly body: string;
    readonly headers?: Record<string, string>;
  }

  /** A stub origin on every interface, so the private address reaches it. */
  async function startOrigin(handler: (path: string) => Answer): Promise<number> {
    const created = createServer((request, response) => {
      seenHosts.push(request.headers.host ?? '');
      const answer = handler(request.url ?? '/');
      response.writeHead(answer.status, { 'content-type': 'text/plain', ...answer.headers });
      response.end(answer.body);
    });
    server = created;
    await new Promise<void>((resolve) => created.listen(0, '0.0.0.0', resolve));
    const address = created.address();
    if (address === null || typeof address === 'string') throw new Error('No port was bound.');
    return address.port;
  }

  const readAll = async (stream: NodeJS.ReadableStream): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  };

  /* ------------------------------ the fence ------------------------- */

  it('refuses a name that resolves to a blocked address', async () => {
    const resolve: HostResolver = () => Promise.resolve([METADATA_ADDRESS]);
    await expect(
      fetchImportUrl(`http://${SAFE_HOST}/thing`, LIMIT_BYTES, { resolve }),
    ).rejects.toThrow(/loopback or link-local/);
  });

  it('refuses when only one of several answers is blocked', async () => {
    const resolve: HostResolver = () => Promise.resolve(['93.184.216.34', '127.0.0.1']);
    await expect(
      fetchImportUrl(`http://${SAFE_HOST}/thing`, LIMIT_BYTES, { resolve }),
    ).rejects.toThrow(/loopback or link-local/);
  });

  it('refuses a literal loopback address without consulting the resolver', async () => {
    let calls = 0;
    const resolve: HostResolver = () => {
      calls += 1;
      return Promise.resolve(['93.184.216.34']);
    };
    await expect(
      fetchImportUrl('http://127.0.0.1:9/thing', LIMIT_BYTES, { resolve }),
    ).rejects.toThrow(/loopback or link-local/);
    expect(calls).toBe(0);
  });

  it('refuses a scheme that is not http or https', async () => {
    const resolve: HostResolver = () => Promise.resolve(['93.184.216.34']);
    await expect(
      fetchImportUrl('ftp://example.invalid/x', LIMIT_BYTES, { resolve }),
    ).rejects.toThrow(/http and https/);
  });

  it('refuses a name that does not resolve at all', async () => {
    const resolve: HostResolver = () => Promise.reject(new Error('NXDOMAIN'));
    await expect(
      fetchImportUrl(`http://${SAFE_HOST}/thing`, LIMIT_BYTES, { resolve }),
    ).rejects.toThrow(/could not be resolved/);
  });

  /* ---------------------------- the pinning ------------------------- */

  it.skipIf(privateAddress === null)(
    'resolves once and connects to that address, so a rebind is never seen',
    async () => {
      const port = await startOrigin(() => ({ status: 200, body: 'the real body' }));

      // The rebind: the first answer is where the stub really is, and every
      // answer after it is the cloud metadata service. Code that re-resolves
      // between the check and the connection fetches from the second one; code
      // that pins to the first never asks again.
      const answers = [[privateAddress as string], [METADATA_ADDRESS]];
      let calls = 0;
      const resolve: HostResolver = () =>
        Promise.resolve(answers[Math.min(calls++, 1)] as string[]);

      const fetched = await fetchImportUrl(`http://${SAFE_HOST}:${port}/thing`, LIMIT_BYTES, {
        resolve,
      });

      expect(await readAll(fetched.body)).toBe('the real body');
      expect(calls).toBe(1);
    },
    40_000,
  );

  it.skipIf(privateAddress === null)(
    'keeps the original Host header, so virtual hosting still works',
    async () => {
      const port = await startOrigin(() => ({ status: 200, body: 'ok' }));
      const resolve: HostResolver = () => Promise.resolve([privateAddress as string]);

      const fetched = await fetchImportUrl(`http://${SAFE_HOST}:${port}/thing`, LIMIT_BYTES, {
        resolve,
      });
      await readAll(fetched.body);

      // Not the literal address the socket went to.
      expect(seenHosts).toEqual([`${SAFE_HOST}:${port}`]);
    },
    40_000,
  );

  it.skipIf(privateAddress === null)(
    're-checks the destination of every redirect hop',
    async () => {
      const port = await startOrigin((path) =>
        path === '/start'
          ? {
              status: 302,
              body: '',
              headers: { location: `http://${METADATA_HOST}/latest/meta-data/` },
            }
          : { status: 200, body: 'should never be reached' },
      );

      const resolve: HostResolver = (hostname) =>
        Promise.resolve(
          hostname === METADATA_HOST ? [METADATA_ADDRESS] : [privateAddress as string],
        );

      await expect(
        fetchImportUrl(`http://${SAFE_HOST}:${port}/start`, LIMIT_BYTES, { resolve }),
      ).rejects.toThrow(/loopback or link-local/);
    },
    40_000,
  );

  it.skipIf(privateAddress === null)(
    'refuses a download whose declared length is over the limit before reading it',
    async () => {
      const body = 'x'.repeat(200);
      const port = await startOrigin(() => ({
        status: 200,
        body,
        headers: { 'content-length': String(body.length) },
      }));
      const resolve: HostResolver = () => Promise.resolve([privateAddress as string]);

      await expect(
        fetchImportUrl(`http://${SAFE_HOST}:${port}/big`, 100, { resolve }),
      ).rejects.toThrow(/import limit/);
    },
    40_000,
  );

  it.skipIf(privateAddress === null)(
    'reports the remote status rather than a stack trace',
    async () => {
      const port = await startOrigin(() => ({ status: 404, body: 'nope' }));
      const resolve: HostResolver = () => Promise.resolve([privateAddress as string]);

      await expect(
        fetchImportUrl(`http://${SAFE_HOST}:${port}/missing`, LIMIT_BYTES, { resolve }),
      ).rejects.toThrow(/HTTP 404/);
    },
    40_000,
  );
});
