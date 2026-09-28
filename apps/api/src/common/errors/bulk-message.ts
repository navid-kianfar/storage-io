import { DomainException } from './domain.exception';
import { mapProviderError } from './provider-error.mapper';

/**
 * The per-row message in a bulk response, for every bulk endpoint in the API.
 *
 * A bulk request answers 200 with a row per target, so the reason one row failed
 * travels in a string rather than in the problem+json envelope — and that string
 * must not say more than the single-target error would. A `DomainException`
 * already carries a caller-safe sentence; anything else is mapped the way the
 * global filter maps it, so no provider body, stack or path crosses the boundary.
 */
export function bulkMessageOf(error: unknown): string {
  if (error instanceof DomainException) return `${error.code}: ${error.message}`;
  const mapped = mapProviderError(error);
  if (mapped !== null) return `${mapped.code}: ${mapped.detail}`;
  return 'INTERNAL: the action failed.';
}
