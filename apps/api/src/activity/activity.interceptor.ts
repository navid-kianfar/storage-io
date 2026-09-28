import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { catchError, tap, throwError, type Observable } from 'rxjs';
import type { Request } from 'express';
import type { ActivityCategory, ActivityResult } from '@storage-io/contracts';
import { SYSTEM_ACTOR, actorOf, clientIpOf } from '../common/actor';
import { requestIdOf } from '../common/request-id';
import { DomainException } from '../common/errors/domain.exception';
import { ActivityService, sanitizeDetails } from './activity.service';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const ACTIVITY_META_KEY = 'sio:activity';
export const ACTIVITY_SKIP_KEY = 'sio:activitySkip';

export interface ActivityMeta {
  readonly category: ActivityCategory;
  /** Dotted verb; defaults to `<category>.<method lowercased>`. */
  readonly action: string;
  readonly title: string;
  /**
   * Title to use when the request failed. Without it a failed attempt is logged
   * under the success wording — "Signed in" on a rejected login is the kind of
   * audit-log entry that misleads exactly when it matters.
   */
  readonly failureTitle?: string;
}

/**
 * Declares what the activity log should say for a route. Without it the
 * interceptor still records the request, using the route path — which is
 * accurate but not readable, so every mutating route should carry one.
 */
export const LogActivity = (meta: ActivityMeta): MethodDecorator =>
  SetMetadata(ACTIVITY_META_KEY, meta);

/** For mutating routes that must not be logged — none today; kept explicit. */
export const SkipActivity = (): MethodDecorator => SetMetadata(ACTIVITY_SKIP_KEY, true);

/**
 * Records every mutating request, successful or not. Applied globally, so a
 * route added later is audited whether or not its author thought about it.
 *
 * Failures are recorded too, with `result: 'failure'` and the error's contract
 * code — an audit trail that only shows what worked is the less useful half.
 */
@Injectable()
export class ActivityInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ActivityInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly activity: ActivityService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    if (!MUTATING_METHODS.has(request.method)) return next.handle();

    const skip = this.reflector.get<boolean>(ACTIVITY_SKIP_KEY, context.getHandler());
    if (skip === true) return next.handle();

    const meta = this.reflector.get<ActivityMeta | undefined>(
      ACTIVITY_META_KEY,
      context.getHandler(),
    );

    return next.handle().pipe(
      tap(() => this.write(request, meta, 'success', {})),
      catchError((error: unknown) => {
        this.write(request, meta, resultFor(error), { errorCode: codeOf(error) });
        return throwError(() => error);
      }),
    );
  }

  private write(
    request: Request,
    meta: ActivityMeta | undefined,
    result: ActivityResult,
    extraDetails: Record<string, unknown>,
  ): void {
    const actor = actorOf(request) ?? SYSTEM_ACTOR;
    const category = meta?.category ?? 'system';
    const action = meta?.action ?? `${category}.${request.method.toLowerCase()}`;
    const fallbackTitle = `${request.method} ${routePathOf(request) ?? request.path}`;
    const title =
      result === 'success'
        ? (meta?.title ?? fallbackTitle)
        : (meta?.failureTitle ?? `Failed: ${meta?.title ?? fallbackTitle}`);

    try {
      this.activity.record({
        category,
        action,
        title,
        actor: { type: actor.type, name: actor.name },
        result,
        target: targetOf(request),
        ip: clientIpOf(request),
        requestId: requestIdOf(request),
        serverId: paramOf(request, 'sid') ?? paramOf(request, 'id'),
        details: {
          method: request.method,
          path: request.path,
          ...sanitizeDetails(bodyOf(request)),
          ...extraDetails,
        },
      });
    } catch (error) {
      // A failed audit write must not turn a working request into a 500, but it
      // must be loud: this is the one place the trail can silently go missing.
      this.logger.error({ err: error, path: request.path }, 'Failed to record activity');
    }
  }
}

/**
 * A 4xx is the caller getting it wrong — a warning in the trail. A 5xx is us
 * getting it wrong, which is a failure. Anything that is not an HttpException at
 * all is an unhandled bug, so it is a failure too.
 */
/** Express types `request.route` as `any`; narrow it before reading `path`. */
function routePathOf(request: Request): string | null {
  const route: unknown = request.route;
  if (typeof route !== 'object' || route === null) return null;
  const { path } = route as { path?: unknown };
  return typeof path === 'string' ? path : null;
}

const resultFor = (error: unknown): ActivityResult => {
  if (error instanceof HttpException) {
    return error.getStatus() < HttpStatus.INTERNAL_SERVER_ERROR ? 'warning' : 'failure';
  }
  return 'failure';
};

/**
 * The contract code, matching what the problem filter sent the caller. A
 * mismatch between the two would make an operator's search for a request id
 * come back with a different story than the client saw.
 */
function codeOf(error: unknown): string {
  if (error instanceof DomainException) return error.code;
  if (error instanceof ZodValidationException) return 'VALIDATION';
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === HttpStatus.TOO_MANY_REQUESTS) return 'RATE_LIMITED';
    if (status === HttpStatus.UNAUTHORIZED) return 'AUTH_INVALID';
    if (status === HttpStatus.FORBIDDEN) return 'FORBIDDEN';
    if (status === HttpStatus.NOT_FOUND) return 'NOT_FOUND';
    if (status < HttpStatus.INTERNAL_SERVER_ERROR) return 'VALIDATION';
  }
  return 'INTERNAL';
}

const paramOf = (request: Request, name: string): string | null => {
  const params = request.params as Record<string, string | undefined>;
  return params[name] ?? null;
};

/** The most specific route parameter, which is what an operator scans for. */
function targetOf(request: Request): string | null {
  const params = request.params as Record<string, string | undefined>;
  return params['bucket'] ?? params['name'] ?? params['accessKeyId'] ?? params['id'] ?? null;
}

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  return { body: body };
}
