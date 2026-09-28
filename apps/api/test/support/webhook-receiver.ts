import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

/**
 * A real HTTP receiver for the webhook channel's tests.
 *
 * A mocked `fetch` would prove that the channel called `fetch`. What is worth
 * proving is that a third party receives a body it can verify with the shared
 * secret — the headers, the exact bytes that were signed, and the fact that the
 * signature does not verify against a different timestamp. Only a socket shows
 * that.
 *
 * It binds an ephemeral port on 127.0.0.1, so nothing leaves the machine and two
 * test files can run without agreeing on a port.
 */

export interface ReceivedWebhook {
  readonly headers: IncomingHttpHeaders;
  /** The raw body, exactly as it arrived — the signature is over these bytes. */
  readonly body: string;
}

export interface WebhookReceiver {
  readonly url: string;
  /** The next request, waiting for it if it has not arrived yet. */
  readonly next: (timeoutMs?: number) => Promise<ReceivedWebhook>;
  readonly close: () => Promise<void>;
}

const DEFAULT_WAIT_MS = 5_000;

export async function startWebhookReceiver(status = 200): Promise<WebhookReceiver> {
  const received: ReceivedWebhook[] = [];
  let notify: (() => void) | null = null;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      notify?.();
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  const next = async (timeoutMs = DEFAULT_WAIT_MS): Promise<ReceivedWebhook> => {
    const first = received.shift();
    if (first !== undefined) return first;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = null;
        reject(new Error('No webhook arrived within the timeout.'));
      }, timeoutMs);
      notify = (): void => {
        clearTimeout(timer);
        notify = null;
        resolve();
      };
    });

    const arrived = received.shift();
    if (arrived === undefined) throw new Error('The receiver was woken with nothing to read.');
    return arrived;
  };

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { url: `http://127.0.0.1:${address.port}/hook`, next, close };
}
