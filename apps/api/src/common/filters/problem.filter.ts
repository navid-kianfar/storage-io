import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  PROBLEM_JSON_CONTENT_TYPE,
  type ErrorCode,
  type ProblemDetails,
  type ProblemFieldError,
} from '@storage-io/contracts';
import { DomainException } from '../errors/domain.exception';
import { mapProviderError } from '../errors/provider-error.mapper';
import { REQUEST_ID_HEADER, requestIdOf } from '../request-id';

/**
 * The single global filter. Everything that escapes a controller leaves through
 * here as RFC 7807 `application/problem+json`, so a client never has to handle
 * two error shapes.
 *
 * It also draws the trust boundary: a stack trace, a SQL fragment or a provider
 * host goes to the log, never to the response. An unrecognised error becomes a
 * flat `INTERNAL` with a fixed sentence.
 */
@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const requestId = requestIdOf(request);

    const problem = this.toProblem(exception, requestId);
    this.log(exception, problem, request);

    // SSE and streaming responses may already be on the wire; a second write of
    // headers would throw and mask the original failure.
    if (response.headersSent) {
      response.end();
      return;
    }

    response.setHeader(REQUEST_ID_HEADER, requestId);
    response.status(problem.status).type(PROBLEM_JSON_CONTENT_TYPE).send(problem);
  }

  private toProblem(exception: unknown, requestId: string): ProblemDetails {
    if (exception instanceof ZodValidationException) {
      return this.problem(
        HttpStatus.BAD_REQUEST,
        'VALIDATION',
        'The request did not match the expected shape.',
        requestId,
        toFieldErrors(exception.getZodError()),
      );
    }

    if (exception instanceof DomainException) {
      return this.problem(
        exception.getStatus(),
        exception.code,
        exception.message,
        requestId,
        exception.fieldErrors,
      );
    }

    if (exception instanceof ThrottlerException) {
      return this.problem(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        'Too many attempts. Wait and try again.',
        requestId,
      );
    }

    // A provider failure can surface from anywhere in a request, so check it
    // before the generic HttpException branch.
    const provider = mapProviderError(exception);
    if (provider !== null) {
      return this.problem(provider.status, provider.code, provider.detail, requestId);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return this.problem(status, codeForStatus(status), detailOf(exception), requestId);
    }

    return this.problem(
      HttpStatus.INTERNAL_SERVER_ERROR,
      'INTERNAL',
      'The request could not be completed.',
      requestId,
    );
  }

  private problem(
    status: number,
    code: ErrorCode,
    detail: string,
    requestId: string,
    errors?: readonly ProblemFieldError[],
  ): ProblemDetails {
    const problem: ProblemDetails = {
      // A resolvable URN per code, so a client can link to an explanation.
      type: `https://storage-io.dev/problems/${code.toLowerCase().replace(/_/g, '-')}`,
      title: TITLES[code],
      status,
      detail,
      code,
      requestId,
    };
    if (errors !== undefined && errors.length > 0) return { ...problem, errors: [...errors] };
    return problem;
  }

  private log(exception: unknown, problem: ProblemDetails, request: Request): void {
    const where = `${request.method} ${request.originalUrl}`;
    const context = { requestId: problem.requestId, code: problem.code, status: problem.status };

    if (problem.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const stack = exception instanceof Error ? exception.stack : String(exception);
      this.logger.error({ ...context, where }, stack);
      return;
    }
    const message = exception instanceof Error ? exception.message : String(exception);
    this.logger.warn({ ...context, where, message });
  }
}

const TITLES: Readonly<Record<ErrorCode, string>> = {
  AUTH_INVALID: 'Authentication failed',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  VALIDATION: 'Invalid request',
  CONFLICT: 'Conflict',
  PROVIDER_ERROR: 'Storage provider error',
  NOT_SUPPORTED: 'Not supported',
  SERVER_OFFLINE: 'Storage server offline',
  BUCKET_NOT_EMPTY: 'Bucket not empty',
  RATE_LIMITED: 'Too many requests',
  INTERNAL: 'Internal error',
};

/** Nest raises bare HttpExceptions (guards, 404 routing); give each a code. */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return 'AUTH_INVALID';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'VALIDATION';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'SERVER_OFFLINE';
    case HttpStatus.BAD_GATEWAY:
    case HttpStatus.GATEWAY_TIMEOUT:
      return 'PROVIDER_ERROR';
    default:
      return status >= HttpStatus.INTERNAL_SERVER_ERROR ? 'INTERNAL' : 'VALIDATION';
  }
}

/** Nest packs its own messages into `{ message, error, statusCode }`. */
function detailOf(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const { message } = body;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
  }
  return exception.message;
}

function toFieldErrors(error: unknown): readonly ProblemFieldError[] {
  if (!(error instanceof z.ZodError)) return [];
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
