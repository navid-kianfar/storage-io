import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';

export const IS_PUBLIC_KEY = 'sio:isPublic';

/**
 * Opts a route out of the global auth guard. Everything is guarded by default,
 * so forgetting this decorator fails closed — which is the way round it should
 * be.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const IS_ORIGIN_EXEMPT_KEY = 'sio:originExempt';

/**
 * Exempts a mutating route from the Origin check. Only for routes a browser
 * cannot be tricked into calling usefully — login, which has no session yet.
 */
export const SkipOriginCheck = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_ORIGIN_EXEMPT_KEY, true);

/** `@Public()` plus hiding the route from the authenticated API docs. */
export const InternalPublic = (): MethodDecorator & ClassDecorator =>
  applyDecorators(Public(), ApiExcludeEndpoint());
