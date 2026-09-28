import { useCallback } from 'react';
import type { FieldValues, UseFormSetError } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { isApiError } from './errors';

/**
 * One place that turns a failed request into something the operator can read.
 *
 * `message` prefers the problem's own `detail` — the API writes it for a human
 * and it names the actual bucket, server or key — and falls back to the stable
 * `code` translation, then to the generic message. `toastError` shows it;
 * `applyFieldErrors` moves a 422's `errors[]` onto the matching form fields so
 * the operator sees the problem next to the input rather than in a toast that
 * disappears.
 */
export interface ApiErrorHandler {
  message: (error: unknown) => string;
  toastError: (error: unknown, title?: string) => void;
  /** Returns true when every field error found a field, so no toast is needed. */
  applyFieldErrors: <TValues extends FieldValues>(
    error: unknown,
    setError: UseFormSetError<TValues>,
    fields: readonly string[],
  ) => boolean;
}

export function useApiError(): ApiErrorHandler {
  const { t, i18n } = useTranslation();

  const message = useCallback(
    (error: unknown): string => {
      if (!isApiError(error)) return t('error.unexpected');
      if (error.isNetworkError) return t('error.network');
      if (error.detail !== null && error.detail.length > 0) return error.detail;
      // `exists`, not `defaultValue: ''`: with `returnEmptyString: false` i18next
      // ignores an empty default and hands back the key, so an error code we have
      // no message for used to reach the operator as the literal text
      // "error.HTTP_502". Seen in the browser when the API restarted mid-request.
      const key = `error.${error.code}`;
      return i18n.exists(key) ? t(key) : t('error.unexpected');
    },
    [i18n, t],
  );

  const toastError = useCallback(
    (error: unknown, title?: string) => {
      toast.error(title ?? t('state.error'), { description: message(error) });
    },
    [message, t],
  );

  const applyFieldErrors = useCallback(
    <TValues extends FieldValues>(
      error: unknown,
      setError: UseFormSetError<TValues>,
      fields: readonly string[],
    ): boolean => {
      if (!isApiError(error) || error.fieldErrors.length === 0) return false;
      let allMatched = true;
      for (const fieldError of error.fieldErrors) {
        // The API's path is dotted (`options.adminEndpoint`); react-hook-form
        // uses the same notation, so a known path maps across directly.
        if (fields.includes(fieldError.path)) {
          setError(fieldError.path as Parameters<UseFormSetError<TValues>>[0], {
            type: 'server',
            message: fieldError.message,
          });
          continue;
        }
        allMatched = false;
      }
      return allMatched;
    },
    [],
  );

  return { message, toastError, applyFieldErrors };
}
