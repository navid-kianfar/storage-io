import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { ActorType } from '@storage-io/contracts';

/**
 * Who is making the request. There is one admin, so this says *how* they
 * authenticated rather than *who* they are — which is what the activity log and
 * the Origin check both need.
 */
export interface Actor {
  readonly type: ActorType;
  readonly name: string;
  /** Set when the request carried a session cookie. */
  readonly sessionId: string | null;
  /** Set when the request carried a Bearer API token. */
  readonly tokenId: string | null;
}

const ACTOR_KEY = 'sioActor';

interface RequestWithActor extends Request {
  [ACTOR_KEY]?: Actor;
}

export const attachActor = (request: Request, actor: Actor): void => {
  (request as RequestWithActor)[ACTOR_KEY] = actor;
};

export const actorOf = (request: Request): Actor | undefined =>
  (request as RequestWithActor)[ACTOR_KEY];

/** The system itself, for events no request caused. */
export const SYSTEM_ACTOR: Actor = {
  type: 'system',
  name: 'storage-io',
  sessionId: null,
  tokenId: null,
};

export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor | undefined => {
    const request = context.switchToHttp().getRequest<Request>();
    return actorOf(request);
  },
);

/**
 * The client address, honouring `X-Forwarded-For` only as far as Express's
 * `trust proxy` setting allows — `request.ip` already applies that rule, so
 * reading the header directly would be the insecure shortcut.
 */
export const clientIpOf = (request: Request): string | null => request.ip ?? null;
