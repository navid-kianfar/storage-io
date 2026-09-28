import { toast } from 'sonner';
import { API_ERROR_CODES, isApiError, type ApiErrorCode } from './errors';

/**
 * Turning an {@link ApiError} into something an operator can read.
 *
 * The API answers with RFC 7807 problem+json, whose `detail` is written for a
 * human ("bucket media-prod still contains 38112 objects"). That sentence is
 * always more useful than a generic message, so it wins; the translated
 * `error.<CODE>` string is the fallback for a code with no detail, and
 * `error.unexpected` the fallback for anything that is not an ApiError at all.
 */

type Translate = (key: string) => string;

function isKnownCode(code: string): code is ApiErrorCode {
  return (API_ERROR_CODES as readonly string[]).includes(code);
}

/** The headline for a failure: the stable code's translation, or a generic one. */
export function problemTitle(error: unknown, t: Translate): string {
  if (!isApiError(error)) return t('error.unexpected');
  if (error.isNetworkError) return t('error.network');
  if (isKnownCode(error.code)) return t(`error.${error.code}`);
  return t('error.unexpected');
}

/** The API's own sentence, when it sent one and it adds something to the title. */
export function problemDetail(error: unknown, t: Translate): string | undefined {
  if (!isApiError(error)) return undefined;
  const detail = error.detail ?? undefined;
  if (detail === undefined || detail.length === 0) return undefined;
  const title = problemTitle(error, t);
  return detail === title ? undefined : detail;
}

/**
 * The one way a failed mutation is reported. `title` overrides the headline when
 * the page has a better one ("Bucket could not be created").
 */
export function toastProblem(error: unknown, t: Translate, title?: string): void {
  const headline = title ?? problemTitle(error, t);
  const description = problemDetail(error, t) ?? (title === undefined ? undefined : problemTitle(error, t));
  toast.error(headline, { description });
}

export type FieldErrorSetter = (path: string, message: string) => void;

/**
 * Maps `problem.errors[]` onto the form fields that produced them, so a
 * validation failure lands under the field rather than only in a toast. Paths the
 * form does not know about are left to the caller's toast.
 */
export function applyFieldErrors(error: unknown, setFieldError: FieldErrorSetter): boolean {
  if (!isApiError(error)) return false;
  if (error.fieldErrors.length === 0) return false;
  for (const fieldError of error.fieldErrors) {
    setFieldError(fieldError.path, fieldError.message);
  }
  return true;
}

/** True when the provider simply cannot do this — the UI shows a disabled state. */
export function isNotSupported(error: unknown): boolean {
  return isApiError(error) && error.is('NOT_SUPPORTED');
}

/** True when the request failed because the storage server is unreachable. */
export function isServerOffline(error: unknown): boolean {
  return isApiError(error) && error.is('SERVER_OFFLINE');
}
