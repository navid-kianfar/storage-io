import { describe, expect, it } from 'vitest';
import { ApiError, isNotFoundError, networkProblem } from './errors';

/**
 * Pages that resolve an opaque id out of the URL — the object browser, the
 * bucket settings page — branch on this predicate to decide between "still
 * loading" and "this entity is not there". Getting it wrong is not a cosmetic
 * bug: the object browser answered a 404 with its ordinary empty state, so a
 * link to a deleted bucket rendered "This folder is empty" over a bucket that
 * did not exist.
 */

function apiError(status: number, code: string): ApiError {
  return new ApiError({
    type: 'https://storage-io.dev/problems/not-found',
    title: 'Not found',
    status,
    detail: 'No such bucket.',
    code,
  });
}

describe('isNotFoundError', () => {
  it('recognises the API problem code', () => {
    expect(isNotFoundError(apiError(404, 'NOT_FOUND'))).toBe(true);
  });

  it('recognises a 404 raised before a handler could set a code', () => {
    expect(isNotFoundError(apiError(404, 'UNKNOWN'))).toBe(true);
  });

  it('is false for every other API failure', () => {
    expect(isNotFoundError(apiError(403, 'FORBIDDEN'))).toBe(false);
    expect(isNotFoundError(apiError(500, 'INTERNAL'))).toBe(false);
  });

  it('is false for a network failure, which is not an answer about existence', () => {
    expect(isNotFoundError(new ApiError(networkProblem('offline')))).toBe(false);
  });

  it('is false for anything that is not an API error at all', () => {
    expect(isNotFoundError(new Error('boom'))).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
  });
});
