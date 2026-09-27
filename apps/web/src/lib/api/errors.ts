/**
 * RFC 7807 problem+json, as the API documents it in docs/API.md:
 * `{ type, title, status, detail, code, errors?: [{ path, message }] }`.
 */
export interface ProblemFieldError {
  readonly path: string;
  readonly message: string;
}

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string | null;
  readonly code: string;
  readonly errors?: readonly ProblemFieldError[];
}

/** Stable `code` values the UI branches on. Anything else is handled generically. */
export const API_ERROR_CODES = [
  'AUTH_INVALID',
  'NOT_FOUND',
  'VALIDATION',
  'CONFLICT',
  'PROVIDER_ERROR',
  'NOT_SUPPORTED',
  'SERVER_OFFLINE',
  'BUCKET_NOT_EMPTY',
  'RATE_LIMITED',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | null;
  readonly fieldErrors: readonly ProblemFieldError[];
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.code = problem.code;
    this.detail = problem.detail;
    this.fieldErrors = problem.errors ?? [];
    this.problem = problem;
  }

  is(code: ApiErrorCode): boolean {
    return this.code === code;
  }

  /** True when the request failed because nothing reached the API at all. */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

/** The client never throws anything else, so callers can narrow with one check. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

const UNKNOWN_STATUS = 0;

export function networkProblem(detail: string): Problem {
  return {
    type: 'about:blank',
    title: 'Network error',
    status: UNKNOWN_STATUS,
    detail,
    code: 'NETWORK',
  };
}

/** Falls back to a synthetic problem when the API answered with something else. */
export function problemFromResponse(response: Response, body: unknown): Problem {
  if (body !== null && typeof body === 'object' && 'title' in body && 'status' in body) {
    const candidate = body as Partial<Problem>;
    return {
      type: candidate.type ?? 'about:blank',
      title: candidate.title ?? response.statusText,
      status: candidate.status ?? response.status,
      detail: candidate.detail ?? null,
      code: candidate.code ?? `HTTP_${response.status}`,
      errors: candidate.errors,
    };
  }
  return {
    type: 'about:blank',
    title: response.statusText || 'Request failed',
    status: response.status,
    detail: typeof body === 'string' && body.length > 0 ? body : null,
    code: `HTTP_${response.status}`,
  };
}
