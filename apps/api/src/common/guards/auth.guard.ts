import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { API_TOKEN_PREFIX, SESSION_COOKIE_NAME } from '@storage-io/contracts';
import { AppConfigService } from '../../config/app-config.service';
import { ApiTokenService } from '../../auth/api-token.service';
import { SessionService } from '../../auth/session.service';
import { attachActor, clientIpOf, type Actor } from '../actor';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthInvalidError } from '../errors/domain.exception';

const BEARER = 'bearer ';

/**
 * Applied globally in `AppModule`, so every route needs authentication unless it
 * is marked `@Public()`. Fail-closed is the point: a new controller added by a
 * later task is protected before anyone remembers to protect it.
 *
 * Two credentials are accepted — the `sio_session` cookie and a `Bearer sio_…`
 * API token — and the one that succeeded is recorded on the request, because the
 * Origin check and the activity log both need to know which it was.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly tokens: ApiTokenService,
    private readonly config: AppConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const actor = this.authenticate(request);
    if (actor === null) {
      throw new AuthInvalidError('Authentication is required.');
    }

    attachActor(request, actor);
    return true;
  }

  private authenticate(request: Request): Actor | null {
    const bearer = this.bearerToken(request);
    if (bearer !== null) {
      const resolved = this.tokens.resolve(bearer);
      if (resolved === null) return null;
      return { type: 'token', name: resolved.name, sessionId: null, tokenId: resolved.id };
    }

    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    const cookie = cookies?.[SESSION_COOKIE_NAME];
    if (cookie === undefined || cookie.length === 0) return null;

    const session = this.sessions.resolve(cookie);
    if (session === null) return null;

    return {
      type: 'admin',
      name: this.config.adminUsername,
      sessionId: session.id,
      tokenId: null,
    };
  }

  /**
   * Only `sio_`-prefixed bearer values are treated as API tokens, so a stray
   * `Authorization` header from a proxy does not shadow a valid cookie.
   */
  private bearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (header === undefined) return null;
    if (!header.toLowerCase().startsWith(BEARER)) return null;

    const value = header.slice(BEARER.length).trim();
    if (!value.startsWith(API_TOKEN_PREFIX)) return null;
    return value;
  }
}

/** Re-exported for the activity log, which records the client address. */
export { clientIpOf };
