import { ApiError, networkProblem, problemFromResponse } from './errors';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

const HTTP_UNAUTHORIZED = 401;
const HTTP_NO_CONTENT = 204;

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Readonly<Record<string, QueryValue | readonly QueryValue[]>>;

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly query?: QueryParams;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Set for endpoints that answer with bytes rather than JSON. */
  readonly accept?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Called once whenever the API says the session is gone. The router installs a
 * handler that sends the browser to /login with a `redirect` param; keeping it a
 * callback is what stops this module importing the router.
 */
type UnauthorizedHandler = () => void;

let onUnauthorized: UnauthorizedHandler = () => {};

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

/** An empty value is left out of the query string entirely, never sent as `?x=`. */
function isEmptyParam(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** One key's value, appended once per item when it is a list. */
function appendParam(search: URLSearchParams, key: string, value: QueryParams[string]): void {
  if (isEmptyParam(value)) return;
  if (!Array.isArray(value)) {
    search.append(key, String(value));
    return;
  }
  for (const item of value) {
    if (isEmptyParam(item)) continue;
    search.append(key, String(item));
  }
}

export function buildUrl(path: string, query?: QueryParams): string {
  const url = `${API_BASE_URL}${path}`;
  if (!query) return url;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    appendParam(search, key, value);
  }
  const qs = search.toString();
  return qs.length > 0 ? `${url}?${qs}` : url;
}

async function readBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    try {
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  }
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * The single way the app talks to the API.
 *
 * - `credentials: 'include'` so the httpOnly session cookie travels.
 * - Any non-2xx becomes an {@link ApiError} carrying the problem+json `code`,
 *   so call sites branch on a stable string rather than a status number.
 * - A 401 fires the unauthorized handler exactly once per response, then still
 *   throws, so the caller's error state is correct while the redirect happens.
 */
export async function request<TResult>(
  path: string,
  options: RequestOptions = {},
): Promise<TResult> {
  const { method = 'GET', query, body, signal, accept = 'application/json', headers } = options;

  const hasJsonBody = body !== undefined && !(body instanceof FormData);
  const requestHeaders: Record<string, string> = { Accept: accept, ...headers };
  if (hasJsonBody) requestHeaders['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      credentials: 'include',
      headers: requestHeaders,
      signal,
      body: hasJsonBody ? JSON.stringify(body) : body,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    const detail = cause instanceof Error ? cause.message : 'The request could not be sent.';
    throw new ApiError(networkProblem(detail));
  }

  if (!response.ok) {
    if (response.status === HTTP_UNAUTHORIZED) onUnauthorized();
    const problemBody = await readBody(response);
    throw new ApiError(problemFromResponse(response, problemBody));
  }

  if (response.status === HTTP_NO_CONTENT) return undefined as TResult;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return (await response.blob()) as TResult;
  return (await response.json()) as TResult;
}

export const api = {
  get: <TResult>(path: string, query?: QueryParams, signal?: AbortSignal) =>
    request<TResult>(path, { method: 'GET', query, signal }),
  post: <TResult>(path: string, body?: unknown, query?: QueryParams) =>
    request<TResult>(path, { method: 'POST', body, query }),
  put: <TResult>(path: string, body?: unknown, query?: QueryParams) =>
    request<TResult>(path, { method: 'PUT', body, query }),
  patch: <TResult>(path: string, body?: unknown, query?: QueryParams) =>
    request<TResult>(path, { method: 'PATCH', body, query }),
  delete: <TResult>(path: string, query?: QueryParams) =>
    request<TResult>(path, { method: 'DELETE', query }),
  /** For the streaming endpoints (`objects/download`, `export.csv`, config export). */
  blob: (path: string, query?: QueryParams) =>
    request<Blob>(path, { method: 'GET', query, accept: '*/*' }),
} as const;
