import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_KEY = 'sioRequestId';
/** A client-supplied id is echoed, but only if it is plausible. */
const ACCEPTABLE_ID = /^[\w.:-]{8,128}$/;

interface RequestWithId extends Request {
  [REQUEST_ID_KEY]?: string;
}

/**
 * Stamps every request with an id, echoes it on the response, and makes it
 * available to the logger, the activity log and the problem filter. One id ties
 * a client's error report to the server's log line.
 */
export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const supplied = request.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
  const id =
    typeof candidate === 'string' && ACCEPTABLE_ID.test(candidate) ? candidate : randomUUID();

  (request as RequestWithId)[REQUEST_ID_KEY] = id;
  response.setHeader(REQUEST_ID_HEADER, id);
  next();
}

/** Falls back to a fresh id so a caller never has to handle `undefined`. */
export function requestIdOf(request: Request): string {
  return (request as RequestWithId)[REQUEST_ID_KEY] ?? randomUUID();
}
