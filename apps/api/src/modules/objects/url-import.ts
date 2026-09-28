import { lookup } from 'node:dns/promises';
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

export interface FetchedUrl {
  readonly body: Readable;
  readonly contentType: string | null;
  readonly contentLength: number | null;
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
 * - **Private ranges are allowed.** This is an on-premise console whose whole
 *   purpose is talking to machines on the operator's own network; refusing
 *   `10.0.0.0/8` would make importing from an internal host impossible. The
 *   endpoint is behind admin authentication and `Settings.security.allowedNetworks`.
 * - **Redirects are followed manually**, because `fetch`'s automatic mode would
 *   follow a redirect into a blocked address without the check ever running.
 * - **A size ceiling is applied to the stream, not to `Content-Length`**, which a
 *   remote server may omit or misreport; the caller pipes through
 *   `SizeLimitedStream`. The declared length is checked first only so an obviously
 *   oversized download is refused before it starts.
 */
export async function fetchImportUrl(url: string, limitBytes: number): Promise<FetchedUrl> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertAllowedDestination(current);

    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: '*/*' },
    });

    const location = response.headers.get('location');
    if (isRedirect(response.status) && location !== null) {
      // Drain the redirect's own body so the socket is released.
      await response.body?.cancel();
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok) {
      throw new ProviderError(`The URL answered HTTP ${response.status}.`);
    }

    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    const contentLength = Number.isFinite(declared) ? declared : null;
    if (contentLength !== null && contentLength > limitBytes) {
      await response.body?.cancel();
      throw new ConflictError(
        `The URL is ${Math.round(contentLength / BYTES_PER_MB)} MB, over the ${Math.round(limitBytes / BYTES_PER_MB)} MB import limit.`,
      );
    }

    const body = response.body;
    if (body === null) throw new ProviderError('The URL returned no body.');

    return {
      body: Readable.fromWeb(body),
      contentType: response.headers.get('content-type'),
      contentLength,
    };
  }

  throw new ValidationError(`The URL redirected more than ${MAX_REDIRECTS} times.`);
}

/* ------------------------------ internals ------------------------- */

const isRedirect = (status: number): boolean => status >= 300 && status < 400;

/** Every address the hostname resolves to has to pass, not just the first. */
async function assertAllowedDestination(target: string): Promise<void> {
  const parsed = parseUrl(target);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Only http and https URLs can be imported.');
  }

  const addresses = await resolveAll(parsed.hostname);
  for (const address of addresses) {
    if (isBlocked(address)) {
      logger.warn({ host: parsed.hostname }, 'Refused an import-url pointing at a local address');
      throw new ValidationError(
        'That URL resolves to a loopback or link-local address, which cannot be imported.',
      );
    }
  }
}

function parseUrl(target: string): URL {
  try {
    return new URL(target);
  } catch {
    throw new ValidationError('That is not a URL this API can fetch.');
  }
}

async function resolveAll(hostname: string): Promise<readonly string[]> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) !== 0) return [bare];

  try {
    const results = await lookup(bare, { all: true });
    return results.map((result) => result.address);
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
