import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode, ProblemFieldError } from '@storage-io/contracts';

/**
 * Every error the API raises on purpose carries a stable `code` from the
 * contract, so a client can branch on it without parsing prose. The message is
 * the `detail` a caller sees, which means it must never contain a provider
 * response body, a SQL fragment or a filesystem path.
 */
export class DomainException extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: ErrorCode,
    detail: string,
    public readonly fieldErrors?: readonly ProblemFieldError[],
  ) {
    super(detail, status);
  }
}

export class NotFoundError extends DomainException {
  constructor(detail: string) {
    super(HttpStatus.NOT_FOUND, 'NOT_FOUND', detail);
  }
}

export class ConflictError extends DomainException {
  constructor(detail: string) {
    super(HttpStatus.CONFLICT, 'CONFLICT', detail);
  }
}

export class ValidationError extends DomainException {
  constructor(detail: string, fieldErrors?: readonly ProblemFieldError[]) {
    super(HttpStatus.BAD_REQUEST, 'VALIDATION', detail, fieldErrors);
  }
}

export class AuthInvalidError extends DomainException {
  constructor(detail = 'Invalid credentials.') {
    super(HttpStatus.UNAUTHORIZED, 'AUTH_INVALID', detail);
  }
}

export class ForbiddenError extends DomainException {
  constructor(detail: string) {
    super(HttpStatus.FORBIDDEN, 'FORBIDDEN', detail);
  }
}

/** The provider answered, but with a failure. 502: it is not the caller's fault. */
export class ProviderError extends DomainException {
  constructor(detail: string) {
    super(HttpStatus.BAD_GATEWAY, 'PROVIDER_ERROR', detail);
  }
}

/** The driver for this provider has no such feature. */
export class NotSupportedError extends DomainException {
  constructor(detail: string) {
    super(HttpStatus.CONFLICT, 'NOT_SUPPORTED', detail);
  }
}

export class ServerOfflineError extends DomainException {
  constructor(detail: string) {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'SERVER_OFFLINE', detail);
  }
}

export class BucketNotEmptyError extends DomainException {
  constructor(detail: string) {
    super(HttpStatus.CONFLICT, 'BUCKET_NOT_EMPTY', detail);
  }
}
