import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import { Logger } from '@nestjs/common';
import {
  ConflictError,
  ProviderError,
  ValidationError,
} from '../../common/errors/domain.exception';

const logger = new Logger('UrlImport');

/** Redirect hops followed. Each hop's destination is checked like the first. */
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 30_000;
const BYTES_PER_MB = 1024 * 1024;

const HTTP_DEFAULT_PORT = 80;
const HTTPS_DEFAULT_PORT = 443;

export interface FetchedUrl {
  readonly body: Readable;
  readonly contentType: string | null;
  readonly contentLength: number | null;
}

/** Every address a hostname resolves to. Injected so a test can stub DNS. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface ImportUrlOptions {
  readonly resolve?: HostResolver;
}

/**
 * Fetches a URL on the operator's instruction, for `POST …/objects/import-url`.
 *
 * This is the one endpoint that makes the API issue an outbound request to an
 * address a caller chose, which is a server-side request forgery primitive unless
 * it is fenced:
 *
 * - **Only http and https** (the contract's schema enforces the scheme; this
 *   re-checks it, because a redirect is not covered by the request schema).
 * - **Loopback, link-local and unspecified addresses are refused**, resolved
 *   rather than pattern-matched on the hostname, so `localtest.me` or a DNS name
 *   pointing at `127.0.0.1` is caught. That also covers the cloud metadata address
 *   `169.254.169.254`, which is link-local.
 * - **The vetted address is the address connected to.** Checking the name and then
 *   handing the name to a client that resolves it again is a DNS rebinding hole:
 *   a name whose record has a one-second TTL answers `93.184.216.34` for the check
 *   and `169.254.169.254` a moment later for the fetch. So the hostname is
 *   resolved exactly once per hop and the socket is opened to that literal
 *   address, with the original `Host` header and TLS server name preserved so
 *   virtual hosting and certificate validation still work.
 * - **Private ranges are allowed.** This is an on-premise console whose whole
 *   purpose is talking to machines on the operator's own network; refusing
 *   `10.0.0.0/8` would make importing from an internal host impossible. The
 *   endpoint is behind admin authentication and `Settings.security.allowedNetworks`.
 * - **Redirects are followed by hand**, because an automatic mode would follow a
 *   redirect into a blocked address without the check ever running — and would
 *   resolve the new host itself, losing the pin.
 * - **A size ceiling is applied to the stream, not to `Content-Length`**, which a
 *   remote server may omit or misreport; the caller pipes through
 *   `SizeLimitedStream`. The declared length is checked first only so an obviously
 *   oversized download is refused before it starts.
 */
export async function fetchImportUrl(
  url: string,
  limitBytes: number,
  options: ImportUrlOptions = {},
): Promise<FetchedUrl> {
  const resolveHost = options.resolve ?? systemResolver;
  let current = parseUrl(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const address = await vetDestination(current, resolveHost);
    const response = await sendPinned(current, address);

    const location = response.headers.location;
    if (isRedirect(response.statusCode ?? 0) && typeof location === 'string') {
      // Nothing of the redirect's body is wanted, and an undrained socket is a
      // socket held open until the timeout.
      response.destroy();
      current = parseUrl(new URL(location, current).toString());
      continue;
    }

    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new ProviderError(`The URL answered HTTP ${status}.`);
    }

    const declared = Number(response.headers['content-length'] ?? Number.NaN);
    const contentLength = Number.isFinite(declared) ? declared : null;
    if (contentLength !== null && contentLength > limitBytes) {
      response.destroy();
      throw new ConflictError(
        `The URL is ${Math.round(contentLength / BYTES_PER_MB)} MB, over the ${Math.round(limitBytes / BYTES_PER_MB)} MB import limit.`,
      );
    }

    return {
      body: response,
      contentType: response.headers['content-type'] ?? null,
      contentLength,
    };
  }

  throw new ValidationError(`The URL redirected more than ${MAX_REDIRECTS} times.`);
}

/* ------------------------------ internals ------------------------- */

const isRedirect = (status: number): boolean => status >= 300 && status < 400;

/**
 * Opens the connection to `address` while the request still speaks as though it
 * had dialled the hostname.
 *
 * `setHost: false` is what stops Node overwriting the `Host` header with the
 * literal address, and `servername` is what makes TLS present the hostname in SNI
 * and check the certificate against it — without either, pinning would break
 * every virtual host and every HTTPS import.
 */
function sendPinned(url: URL, address: string): Promise<IncomingMessage> {
  const secure = url.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  const defaultPort = secure ? HTTPS_DEFAULT_PORT : HTTP_DEFAULT_PORT;

  return new Promise<IncomingMessage>((resolve, reject) => {
    const outbound = send({
      host: address,
      port: url.port === '' ? defaultPort : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      setHost: false,
      headers: { host: url.host, accept: '*/*' },
      ...(secure ? { servername: url.hostname } : {}),
    });

    outbound.setTimeout(FETCH_TIMEOUT_MS, () => {
      outbound.destroy(new ProviderError('The URL did not answer in time.'));
    });
    outbound.on('response', resolve);
    outbound.on('error', (error: Error) => {
      reject(
        error instanceof ProviderError ? error : new ProviderError('The URL could not be reached.'),
      );
    });
    outbound.end();
  });
}

/**
 * The one address the fetch may use. Every address the hostname resolves to has
 * to pass, not just the one picked — a name with both a public and a loopback
 * record must not be importable.
 */
async function vetDestination(parsed: URL, resolveHost: HostResolver): Promise<string> {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Only http and https URLs can be imported.');
  }

  const addresses = await resolveAll(parsed.hostname, resolveHost);
  for (const address of addresses) {
    if (isBlocked(address)) {
      logger.warn({ host: parsed.hostname }, 'Refused an import-url pointing at a local address');
      throw new ValidationError(
        'That URL resolves to a loopback or link-local address, which cannot be imported.',
      );
    }
  }

  const pinned = addresses[0];
  if (pinned === undefined) {
    throw new ValidationError(`The host "${parsed.hostname}" could not be resolved.`);
  }
  return pinned;
}

function parseUrl(target: string): URL {
  try {
    return new URL(target);
  } catch {
    throw new ValidationError('That is not a URL this API can fetch.');
  }
}

const systemResolver: HostResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((result) => result.address);
};

async function resolveAll(hostname: string, resolveHost: HostResolver): Promise<readonly string[]> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) !== 0) return [bare];

  try {
    return await resolveHost(bare);
  } catch {
    // A name that does not resolve cannot be fetched either; failing here gives a
    // clearer message than a socket error three frames later.
    throw new ValidationError(`The host "${hostname}" could not be resolved.`);
  }
}

/**
 * Loopback, link-local and the unspecified address. Private ranges are
 * deliberately absent — see the note on `fetchImportUrl`.
 */
export function isBlocked(address: string): boolean {
  if (address === '0.0.0.0' || address === '::' || address === '::0') return true;
  if (address.startsWith('127.')) return true;
  if (address.startsWith('169.254.')) return true;

  const lower = address.toLowerCase();
  if (lower === '::1') return true;
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  if (lower.startsWith('::ffff:')) return isBlocked(lower.slice('::ffff:'.length));
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;

  return false;
}
