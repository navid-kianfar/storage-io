import type { IncomingMessage } from 'node:http';

/**
 * The routes whose body is object bytes and must reach the handler as an unread
 * stream: the whole-object PUTs, and each part of a resumable multipart upload.
 *
 * Express's JSON parser matches on `Content-Type`, so uploading a `.json` file —
 * or any `application/json` body — would otherwise be read into memory and parsed
 * before the handler ever sees it: the upload would arrive as an empty stream, and
 * a large one would hit the 2 MB JSON limit. `bootstrap.ts` gives the parser this
 * predicate so these paths are skipped whatever type they declare.
 *
 * Matched on `originalUrl` rather than `path`: this runs as Express middleware,
 * where the mount path has been stripped from `path`.
 */
const RAW_BODY_SUFFIXES: readonly string[] = ['/objects/upload', '/objects/content'];

/** `…/objects/multipart/<uploadId>/parts/<n>` — one part of a resumable upload. */
const MULTIPART_PART_PATH = /\/objects\/multipart\/[^/]+\/parts\/\d+$/;

export function isRawObjectBodyRequest(request: IncomingMessage): boolean {
  const url = request.url ?? '';
  const path = url.split('?')[0] ?? '';
  if (RAW_BODY_SUFFIXES.some((suffix) => path.endsWith(suffix))) return true;
  return MULTIPART_PART_PATH.test(path);
}
