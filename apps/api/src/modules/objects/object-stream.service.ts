import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable, Logger } from '@nestjs/common';
import {
  GetObjectCommand,
  HeadObjectCommand,
  type GetObjectCommandOutput,
  type S3Client,
  type StorageClass,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { ZipArchive } from 'archiver';
import type { Response } from 'express';
import type { ObjectItem } from '@storage-io/contracts';
import { ConflictError, NotFoundError, ProviderError } from '../../common/errors/domain.exception';
import { SettingsService } from '../../settings/settings.service';
import { ObjectDeleteService } from './object-delete.service';

const BYTES_PER_MB = 1024 * 1024;
/** `Content-Type` for a body whose type the client did not declare. */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const ZIP_CONTENT_TYPE = 'application/zip';

/* --------------------- what a browser may render ------------------ */

/**
 * The object store holds whatever an operator (or an application writing through
 * one of their access keys) put in it, and the console is served from the same
 * origin as this API. So a `text/html` object handed back as `text/html` with
 * `Content-Disposition: inline` is stored cross-site scripting against the
 * console's own origin — session cookie included.
 *
 * Only inert types are therefore rendered. Everything else is
 * `application/octet-stream` with an `attachment` disposition, whatever the
 * provider said the type was and whatever `?inline=true` asked for.
 */
const INLINE_EXACT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'application/pdf',
];
/** Whole families a browser plays rather than executes. */
const INLINE_TYPE_PREFIXES: readonly string[] = ['video/', 'audio/'];
/**
 * Every `text/*` subtype is served as plain text with an explicit charset.
 * `text/html` therefore shows as source, and a missing charset can no longer be
 * sniffed into UTF-7 or the page's own encoding.
 */
const TEXT_PLAIN_CONTENT_TYPE = 'text/plain; charset=utf-8';

/**
 * Sent on every response that carries object bytes.
 *
 * `nosniff` stops the browser second-guessing the type above; the policy makes
 * the response a document that can load nothing and run nothing. `sandbox` with
 * no tokens is the strongest form — a unique origin with scripts, forms and
 * plugins off — and `img-src`/`media-src`/`frame-src 'self' blob:` are what the
 * built-in PDF and media viewers need to still render the bytes themselves.
 */
export const DOWNLOAD_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; style-src 'unsafe-inline'; sandbox",
};
/** Keys pulled into one ZIP before the request is refused. */
export const ZIP_MAX_ENTRIES = 10_000;
/** No compression: object stores hold compressed data, and this is CPU we save. */
const ZIP_COMPRESSION_LEVEL = 0;

export interface UploadInput {
  readonly bucket: string;
  readonly key: string;
  readonly body: Readable;
  readonly contentType: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly storageClass: string | null;
  /** Known up front for a raw PUT; `null` for a body of unknown length. */
  readonly contentLength: number | null;
}

export interface DownloadInput {
  readonly bucket: string;
  readonly key: string;
  readonly versionId?: string;
  readonly inline: boolean;
  /** The caller's `Range` header, passed through untouched. */
  readonly range?: string;
}

/**
 * Everything that moves object bytes. Nothing here buffers a body:
 *
 * - **Upload** goes through `@aws-sdk/lib-storage`'s `Upload`, which turns a
 *   stream into a single `PutObject` or a multipart upload depending on how much
 *   arrives, with the part size and concurrency the operator configured under
 *   `Settings.transfers`. A 40 GB upload therefore costs one part in memory, not
 *   forty gigabytes.
 * - **Download** passes the caller's `Range` header to the provider and pipes the
 *   provider's own body to the response, so a seek in a video player is one ranged
 *   request end to end rather than a full object read.
 * - **ZIP** streams: entries are appended as their `GetObject` bodies arrive and
 *   the archive is written to the response as it is built, so a 50 GB selection
 *   never exists anywhere at once.
 *
 * Once a byte of a streamed response has been written, an error can no longer
 * become a `problem+json`: the status and headers are already gone. Those failures
 * are logged and the connection is destroyed, which is what tells the client the
 * download is incomplete.
 */
@Injectable()
export class ObjectStreamService {
  private readonly logger = new Logger(ObjectStreamService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly deleter: ObjectDeleteService,
  ) {}

  /* ------------------------------- upload -------------------------- */

  /** Refuses when the key already exists, for `overwrite=false`. */
  async assertAbsent(client: S3Client, bucket: string, key: string): Promise<void> {
    const exists = await this.exists(client, bucket, key);
    if (exists) {
      throw new ConflictError(`"${key}" already exists in this bucket. Retry with overwrite=true.`);
    }
  }

  async exists(client: S3Client, bucket: string, key: string): Promise<boolean> {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      // Any failure here is treated as "not there": the only caller is an
      // overwrite guard, and the subsequent PUT reports a real problem properly.
      return false;
    }
  }

  async upload(client: S3Client, input: UploadInput): Promise<ObjectItem> {
    const transfers = this.settings.getInternal().transfers;

    const upload = new Upload({
      client,
      partSize: transfers.partSizeMb * BYTES_PER_MB,
      queueSize: transfers.parallel,
      // A failed multipart upload must not leave parts behind that the operator
      // then pays for and has to find; `Settings.transfers.keepIncompleteDays`
      // covers the ones an aborted connection leaves.
      leavePartsOnError: false,
      params: {
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType ?? DEFAULT_CONTENT_TYPE,
        ...(Object.keys(input.metadata).length === 0 ? {} : { Metadata: { ...input.metadata } }),
        ...(Object.keys(input.tags).length === 0 ? {} : { Tagging: encodeTagging(input.tags) }),
        // The SDK enumerates AWS's own classes; MinIO and Ceph accept names of
        // their own, which the contract therefore keeps as a string.
        ...(input.storageClass === null
          ? {}
          : { StorageClass: input.storageClass as StorageClass }),
      },
    });

    const result = await upload.done();
    const head = await client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }));

    return {
      key: input.key,
      size: head.ContentLength ?? input.contentLength ?? 0,
      lastModified: (head.LastModified ?? new Date()).toISOString(),
      etag: stripQuotes(result.ETag ?? head.ETag ?? ''),
      storageClass: head.StorageClass ?? null,
      versionId: head.VersionId ?? null,
      isLatest: true,
      deleteMarker: false,
    };
  }

  /* ------------------------------ download ------------------------- */

  /**
   * Streams one object to the response. Returns the number of bytes the provider
   * said it would send, which is what the activity entry records — counting them
   * as they pass would mean wrapping the stream for no extra truth.
   */
  async download(client: S3Client, response: Response, input: DownloadInput): Promise<number> {
    const object = await client.send(
      new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        ...(input.versionId === undefined ? {} : { VersionId: input.versionId }),
        ...(input.range === undefined ? {} : { Range: input.range }),
      }),
    );

    const body = asReadable(object.Body);
    if (body === null) throw new ProviderError('The storage server returned an empty body.');

    applyDownloadHeaders(response, object, input);
    await pipeline(body, response);
    return object.ContentLength ?? 0;
  }

  /* --------------------------------- ZIP --------------------------- */

  /**
   * A ZIP of the given keys and prefixes, written to the response as it is built.
   *
   * Entries are added sequentially on purpose: the archive format is a single
   * ordered stream, so fetching several objects at once would only buy memory
   * pressure while the archiver waited its turn.
   */
  async zip(
    client: S3Client,
    response: Response,
    bucket: string,
    keys: readonly string[],
    prefixes: readonly string[],
    filename: string,
  ): Promise<number> {
    const entries = await this.collectZipEntries(client, bucket, keys, prefixes);

    response.setHeader('Content-Type', ZIP_CONTENT_TYPE);
    applyDownloadSecurityHeaders(response);
    response.setHeader('Content-Disposition', contentDisposition(false, filename));
    // Length is unknown until the archive is finished, so the response is chunked.
    response.setHeader('Cache-Control', 'no-store');

    const archive = new ZipArchive({ zlib: { level: ZIP_COMPRESSION_LEVEL } });
    let bytes = 0;
    archive.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    archive.on('warning', (error) => {
      this.logger.warn({ bucket, err: error.message }, 'ZIP archiver warning');
    });

    // Started here and awaited on every path below, including the failing ones.
    // An outstanding `pipeline` promise is fire-and-forget: when a `GetObject`
    // partway through the selection throws, the response is torn down, the
    // pipeline rejects with ERR_STREAM_PREMATURE_CLOSE and — with nothing
    // observing it — Node takes the whole process down.
    const piped = pipeline(archive, response);
    let failure: Error | null = null;

    try {
      for (const key of entries) {
        const name = zipEntryName(key);
        if (name === null) {
          // An entry whose whole path was traversal or separators has no safe
          // name to give it, so it is left out and said so rather than renamed
          // to something the operator did not ask for.
          this.logger.warn({ bucket, key }, 'Skipped a ZIP entry with no safe name');
          continue;
        }
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = asReadable(object.Body);
        if (body === null) continue;
        archive.append(body, { name, date: object.LastModified });
      }
      await archive.finalize();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      archive.destroy(failure);
    }

    if (failure === null) {
      await piped;
      return bytes;
    }

    // The pipeline is now rejecting too, because the archive above was destroyed.
    // Its rejection is observed and dropped so the caller sees the cause rather
    // than the consequence.
    await piped.catch(() => undefined);
    throw failure;
  }

  private async collectZipEntries(
    client: S3Client,
    bucket: string,
    keys: readonly string[],
    prefixes: readonly string[],
  ): Promise<readonly string[]> {
    const collected = new Set(keys);

    for (const prefix of prefixes) {
      const remaining = ZIP_MAX_ENTRIES - collected.size;
      if (remaining <= 0) break;
      const listed = await this.deleter.listKeys(client, bucket, prefix, remaining + 1);
      for (const key of listed.keys) collected.add(key);
    }

    if (collected.size === 0) {
      throw new NotFoundError('The selection contains no objects to download.');
    }
    if (collected.size > ZIP_MAX_ENTRIES) {
      throw new ConflictError(
        `A ZIP download is limited to ${ZIP_MAX_ENTRIES} objects. Narrow the selection or copy the prefix to another bucket with a bulk job instead.`,
      );
    }
    // A folder placeholder is a zero-byte key ending in `/`; ZIP directories are
    // implied by the entry names, so including them produces a broken archive.
    return [...collected].filter((key) => !key.endsWith('/'));
  }
}

/* ------------------------------ helpers --------------------------- */

/** `Tagging` on a PUT is a URL-encoded query string, not a JSON object. */
export function encodeTagging(tags: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(tags)) params.append(key, value);
  return params.toString();
}

export const stripQuotes = (etag: string): string => etag.replace(/^"|"$/g, '');

/**
 * The SDK types `Body` as a union covering browser streams too. Narrowing it here
 * keeps the cast in one place instead of at each call site.
 */
function asReadable(body: GetObjectCommandOutput['Body']): Readable | null {
  if (body === undefined) return null;
  if (body instanceof Readable) return body;
  return null;
}

/**
 * How an object is handed to the browser: never as the provider described it,
 * always as one of the types the allow-list above says is safe to render.
 *
 * `inline` in the answer is the caller's `?inline=true` **and** the type earning
 * it — a type off the allow-list is an attachment even when the caller asked for
 * inline, because "download it instead" is the safe failure.
 */
export function downloadPresentation(
  providerType: string | null | undefined,
  wantsInline: boolean,
): { readonly contentType: string; readonly inline: boolean } {
  const base = (providerType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  if (base.startsWith('text/')) {
    return { contentType: TEXT_PLAIN_CONTENT_TYPE, inline: wantsInline };
  }
  if (INLINE_EXACT_TYPES.includes(base)) return { contentType: base, inline: wantsInline };
  for (const prefix of INLINE_TYPE_PREFIXES) {
    if (base.startsWith(prefix)) return { contentType: base, inline: wantsInline };
  }
  // image/svg+xml, application/xml, application/javascript and everything else a
  // browser would execute or treat as markup.
  return { contentType: DEFAULT_CONTENT_TYPE, inline: false };
}

/**
 * The response headers for one object's bytes: the provider's cache and validator
 * headers pass through, its `Content-Type` does not (see `downloadPresentation`),
 * and 206 is set for a satisfied range — without which a media player will not
 * seek.
 */
function applyDownloadHeaders(
  response: Response,
  object: GetObjectCommandOutput,
  input: DownloadInput,
): void {
  const presentation = downloadPresentation(object.ContentType, input.inline);

  response.setHeader('Content-Type', presentation.contentType);
  applyDownloadSecurityHeaders(response);
  response.setHeader('Accept-Ranges', 'bytes');
  if (object.ContentLength !== undefined) {
    response.setHeader('Content-Length', String(object.ContentLength));
  }
  if (object.ETag !== undefined) response.setHeader('ETag', object.ETag);
  if (object.LastModified !== undefined) {
    response.setHeader('Last-Modified', object.LastModified.toUTCString());
  }
  if (object.CacheControl !== undefined) response.setHeader('Cache-Control', object.CacheControl);
  if (object.ContentEncoding !== undefined) {
    response.setHeader('Content-Encoding', object.ContentEncoding);
  }

  response.setHeader(
    'Content-Disposition',
    contentDisposition(presentation.inline, basenameOf(input.key)),
  );

  if (object.ContentRange !== undefined) {
    response.setHeader('Content-Range', object.ContentRange);
    response.status(206);
  }
}

/** Overwrites the app-wide CSP `bootstrap.ts` set, which is far looser than this. */
export function applyDownloadSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(DOWNLOAD_SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

/**
 * RFC 5987 encoding, always. An object key may contain a quote, a newline or a
 * non-ASCII character, and an unencoded filename in this header is both a broken
 * download and a response-splitting opportunity.
 */
export function contentDisposition(inline: boolean, filename: string): string {
  const disposition = inline ? 'inline' : 'attachment';
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const basenameOf = (key: string): string => key.split('/').filter(Boolean).pop() ?? key;

/**
 * The name an object key is written under inside a ZIP.
 *
 * An object key is not a path — S3 will happily store `../../etc/cron.d/x` or
 * `/etc/passwd` — and several extractors still resolve entry names against the
 * destination directory. So the name is normalised here: backslashes become
 * separators (Windows extractors treat them as such), leading slashes are
 * dropped, and `.` and `..` segments are removed rather than resolved, because
 * resolving them would still let a key climb above the archive root.
 *
 * `null` when nothing is left — the caller skips that entry and reports it.
 */
export function zipEntryName(key: string): string | null {
  const segments = key
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  if (segments.length === 0) return null;
  return segments.join('/');
}

/**
 * A pass-through that fails once more than `limitBytes` has gone through it.
 *
 * `import-url` needs this because the ceiling cannot be enforced from
 * `Content-Length`: a remote server may omit it, or state one length and send
 * another. Failing mid-stream aborts the upload, and `leavePartsOnError: false`
 * means the partial multipart upload is cleaned up rather than left behind.
 */
export class SizeLimitedStream extends Transform {
  private seen = 0;

  constructor(private readonly limitBytes: number) {
    super();
  }

  get bytesSeen(): number {
    return this.seen;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.seen += chunk.length;
    if (this.seen > this.limitBytes) {
      done(
        new ConflictError(
          `The download exceeded the ${Math.round(this.limitBytes / BYTES_PER_MB)} MB import limit.`,
        ),
      );
      return;
    }
    done(null, chunk);
  }
}
