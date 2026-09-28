import { SetMetadata, type ExecutionContext } from '@nestjs/common';

/**
 * Name of the throttler bucket the login route uses, kept separate from the
 * API-wide bucket so brute-force protection can be tight without throttling
 * ordinary traffic.
 *
 * **The trap this works around:** in `@nestjs/throttler` v6 every configured
 * throttler applies to every route. `@Throttle({ login: {} })` only *overrides
 * options* for that bucket on that route — it does not restrict the bucket to
 * it. Without the `skipIf` below, a login limit of 10/minute rate-limited the
 * whole API after ten requests, which an e2e test caught.
 *
 * So the login bucket skips itself everywhere except routes carrying
 * `@LoginThrottled()`. That is path-independent: moving or renaming the route
 * cannot silently detach the limit.
 */
export const LOGIN_THROTTLER = 'login';

/** Name of the default (whole-API) bucket. */
export const DEFAULT_THROTTLER = 'default';

const LOGIN_THROTTLED_KEY = 'sio:loginThrottled';

/** Marks the route the login bucket applies to. */
export const LoginThrottled = (): MethodDecorator => SetMetadata(LOGIN_THROTTLED_KEY, true);

/** Passed to the login bucket as `skipIf`: skip unless the route is marked. */
export function skipUnlessLoginRoute(context: ExecutionContext): boolean {
  if (context.getType() !== 'http') return true;
  const marked: unknown = Reflect.getMetadata(LOGIN_THROTTLED_KEY, context.getHandler());
  return marked !== true;
}
