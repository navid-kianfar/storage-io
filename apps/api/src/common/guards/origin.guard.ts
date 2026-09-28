import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { actorOf } from '../actor';
import { IS_ORIGIN_EXEMPT_KEY, IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ForbiddenError } from '../errors/domain.exception';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence for cookie sessions. `SameSite=Strict` already stops a
 * cross-site request from carrying the cookie, and this is the second line: a
 * cookie-authenticated mutation must present an `Origin` (or `Referer`) that
 * matches the host serving the API, or one the operator allow-listed.
 *
 * API-token requests are exempt — a browser never attaches an `Authorization`
 * header on its own, so there is nothing to forge.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  private readonly logger = new Logger(OriginGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const exempt = this.reflector.getAllAndOverride<boolean>(IS_ORIGIN_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt === true) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (!MUTATING_METHODS.has(request.method)) return true;

    const actor = actorOf(request);
    // Only a cookie session is forgeable from another origin.
    if (actor === undefined || actor.sessionId === null) return true;

    const origin = this.claimedOrigin(request);
    if (origin === null) {
      throw new ForbiddenError('A cookie-authenticated change requires an Origin header.');
    }

    if (!this.isAcceptable(origin, request)) {
      this.logger.warn({ origin, path: request.path }, 'Rejected by Origin check');
      throw new ForbiddenError('The request Origin is not allowed.');
    }

    return true;
  }

  /** `Origin` when present; otherwise the origin part of `Referer`. */
  private claimedOrigin(request: Request): string | null {
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') return origin;

    const referer = request.headers.referer;
    if (typeof referer !== 'string' || referer.length === 0) return null;
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }

  private isAcceptable(origin: string, request: Request): boolean {
    if (this.config.allowedOrigins.includes(origin)) return true;

    // Same-origin: the browser's Origin must name the host it reached us on.
    const host = request.headers.host;
    if (typeof host !== 'string' || host.length === 0) return false;

    try {
      const claimed = new URL(origin);
      return claimed.host === host;
    } catch {
      return false;
    }
  }
}
