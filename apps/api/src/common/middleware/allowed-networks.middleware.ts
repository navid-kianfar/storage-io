import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { PROBLEM_JSON_CONTENT_TYPE, type ProblemDetails } from '@storage-io/contracts';
import { SettingsService } from '../../settings/settings.service';
import { addressIsAllowed } from '../net/cidr';
import { REQUEST_ID_HEADER, requestIdOf } from '../request-id';

/** Paths that answer before the CIDR list, so a lock-out is diagnosable. */
const ALWAYS_REACHABLE = ['/health'] as const;

/**
 * `request.path` is the WRONG source here. Nest mounts middleware on a wildcard
 * route, and Express strips the mount path, so inside this middleware
 * `request.path` is `/` for every request. `originalUrl` is never rewritten.
 */
function requestPathOf(request: Request): string {
  const url = request.originalUrl;
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * Enforces `Settings.security.allowedNetworks`. It runs as middleware rather
 * than a guard so it applies to every route — including the SSE stream and the
 * streaming object endpoints, which never reach a controller handler.
 *
 * An empty list allows everything. `/health` is always reachable: an operator who
 * has locked themselves out still needs to see the API is alive.
 */
@Injectable()
export class AllowedNetworksMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AllowedNetworksMiddleware.name);

  constructor(private readonly settings: SettingsService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const path = requestPathOf(request);
    if (ALWAYS_REACHABLE.includes(path as (typeof ALWAYS_REACHABLE)[number])) {
      next();
      return;
    }

    const allowed = this.settings.allowedNetworks;
    if (allowed.length === 0) {
      next();
      return;
    }

    const address = request.ip ?? null;
    if (addressIsAllowed(allowed, address)) {
      next();
      return;
    }

    const requestId = requestIdOf(request);
    this.logger.warn({ requestId, address, path }, 'Rejected by allowed-networks');

    // Written here rather than thrown: middleware runs before the exception
    // filter is in the chain for streaming routes.
    const problem: ProblemDetails = {
      type: 'https://storage-io.dev/problems/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'Your network is not on the allowed list.',
      code: 'FORBIDDEN',
      requestId,
    };
    response
      .status(problem.status)
      .setHeader(REQUEST_ID_HEADER, requestId)
      .type(PROBLEM_JSON_CONTENT_TYPE)
      .send(problem);
  }
}
