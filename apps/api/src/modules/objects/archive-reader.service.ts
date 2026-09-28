import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { Injectable, Logger } from '@nestjs/common';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { ArchiveEntriesResponse, ArchiveEntry } from '@storage-io/contracts';
import { mapProviderError } from '../../common/errors/provider-error.mapper';

/** The ZIP end-of-central-directory record, and the most a trailing comment can add. */
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
const MAX_ZIP_COMMENT = 0xffff;
/** One read that covers the EOCD, its 64-bit variants and any comment. */
const EOCD_SEARCH_BYTES = EOCD_FIXED_SIZE + MAX_ZIP_COMMENT + 64;

const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_FIXED_SIZE = 46;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** A 32-bit field set to all ones means "read the real value from the ZIP64 extra". */
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_EXTRA_ID = 0x0001;

/** How much of the central directory is read. Past this the listing is truncated. */
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

const TAR_BLOCK_SIZE = 512;
const TAR_MAGIC_OFFSET = 257;
/** Bytes of tar scanned before giving up: a tar has no index to seek to. */
const MAX_TAR_SCAN_BYTES = 64 * 1024 * 1024;

const MAGIC_SNIFF_BYTES = TAR_BLOCK_SIZE;
const GZIP_MAGIC = 0x1f8b;

/**
 * Lists what is inside an archive object, for the preview pane.
 *
 * The two formats are read in the two ways their layouts allow:
 *
 * - **ZIP has an index**, so it is read with two or three ranged `GetObject`s: the
 *   tail, to find the end-of-central-directory record, then the central directory
 *   itself. A 40 GB ZIP therefore costs a few hundred kilobytes of transfer, which
 *   is the whole reason this endpoint exists instead of downloading the object.
 * - **tar has no index.** Its entries are 512-byte headers interleaved with the
 *   data, so the only way to list it is to read from the start, skipping each
 *   entry's payload. That is bounded by a byte budget and reported as `truncated`
 *   rather than left to run to the end of a large archive.
 *
 * The format is decided by the object's own leading bytes, not its name: an
 * operator's `backup.dat` may well be a ZIP, and a `.zip` may well not be.
 */
@Injectable()
export class ArchiveReaderService {
  private readonly logger = new Logger(ArchiveReaderService.name);

  async list(
    client: S3Client,
    bucket: string,
    key: string,
    versionId: string | undefined,
    limit: number,
  ): Promise<ArchiveEntriesResponse> {
    const head = await this.sniff(client, bucket, key, versionId);
    if (head === null) return { format: 'unsupported', entries: [], truncated: false };

    const format = sniffFormat(head.body, head.totalBytes);

    switch (format) {
      case 'zip':
        return this.readZip(client, bucket, key, versionId, head.totalBytes, limit);
      case 'gzip':
      case 'tar':
        return this.readTar(client, bucket, key, versionId, limit, format === 'gzip');
      case 'unsupported':
        return { format: 'unsupported', entries: [], truncated: false };
    }
  }

  /* --------------------------------- ZIP ---------------------------- */

  private async readZip(
    client: S3Client,
    bucket: string,
    key: string,
    versionId: string | undefined,
    totalBytes: number,
    limit: number,
  ): Promise<ArchiveEntriesResponse> {
    const tailLength = Math.min(EOCD_SEARCH_BYTES, totalBytes);
    const tailStart = totalBytes - tailLength;
    const tail = await this.range(client, bucket, key, versionId, tailStart, totalBytes - 1);

    const directory = locateCentralDirectory(tail.body, tailStart);
    if (directory === null) {
      // A ZIP magic at the front with no end record is a truncated or corrupt file;
      // the pane should say "cannot read this", not fail the request.
      this.logger.debug({ bucket, key }, 'ZIP has no end-of-central-directory record');
      return { format: 'unsupported', entries: [], truncated: false };
    }

    const readable = Math.min(directory.size, MAX_CENTRAL_DIRECTORY_BYTES);
    const central = await this.range(
      client,
      bucket,
      key,
      versionId,
      directory.offset,
      directory.offset + readable - 1,
    );

    const parsed = parseCentralDirectory(central.body, limit);
    return {
      format: 'zip',
      entries: parsed.entries,
      truncated: parsed.truncated || readable < directory.size,
    };
  }

  /* --------------------------------- tar ---------------------------- */

  private async readTar(
    client: S3Client,
    bucket: string,
    key: string,
    versionId: string | undefined,
    limit: number,
    gzipped: boolean,
  ): Promise<ArchiveEntriesResponse> {
    const object = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(versionId === undefined ? {} : { VersionId: versionId }),
      }),
    );
    const body = object.Body;
    if (!(body instanceof Readable)) {
      return { format: 'unsupported', entries: [], truncated: false };
    }

    const source = gzipped ? body.pipe(createGunzip()) : body;
    try {
      return await scanTar(source, limit);
    } catch (error) {
      // A gzip stream that is not a tar, or a tar that ends mid-header. Whatever was
      // read is still worth showing, so this reports what a scan of nothing would.
      this.logger.debug(
        { bucket, key, err: error instanceof Error ? error.message : String(error) },
        'Archive could not be scanned as a tar',
      );
      return { format: 'unsupported', entries: [], truncated: false };
    } finally {
      // The scan stops early on purpose; the socket has to be released with it.
      body.destroy();
    }
  }

  /* ------------------------------ internals ------------------------- */

  /**
   * The leading block, or `null` when the object cannot carry an archive.
   *
   * A zero-byte object answers a ranged read with 416 `InvalidRange`, and this
   * endpoint's job is to say "not an archive" rather than to surface a provider
   * error for a question that has a perfectly good answer. A key that does not exist
   * is different — that is a 404, and it is re-raised.
   */
  private async sniff(
    client: S3Client,
    bucket: string,
    key: string,
    versionId: string | undefined,
  ): Promise<{ body: Buffer; totalBytes: number } | null> {
    try {
      return await this.range(client, bucket, key, versionId, 0, MAGIC_SNIFF_BYTES - 1);
    } catch (error) {
      const mapped = mapProviderError(error);
      if (mapped?.code === 'NOT_FOUND') throw error;
      this.logger.debug(
        { bucket, key, err: error instanceof Error ? error.message : String(error) },
        'Object could not be read as an archive; reporting it as unsupported',
      );
      return null;
    }
  }

  /**
   * One ranged read. `totalBytes` comes from `Content-Range`, so the object's size
   * is learned from the same call rather than a separate `HeadObject`.
   */
  private async range(
    client: S3Client,
    bucket: string,
    key: string,
    versionId: string | undefined,
    start: number,
    end: number,
  ): Promise<{ body: Buffer; totalBytes: number }> {
    const object = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=${start}-${end}`,
        ...(versionId === undefined ? {} : { VersionId: versionId }),
      }),
    );

    const body = object.Body;
    if (!(body instanceof Readable)) {
      return { body: Buffer.alloc(0), totalBytes: 0 };
    }

    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }

    return {
      body: Buffer.concat(chunks),
      totalBytes: totalOf(object.ContentRange) ?? object.ContentLength ?? 0,
    };
  }
}

/* ------------------------------ helpers --------------------------- */

type SniffedFormat = 'zip' | 'tar' | 'gzip' | 'unsupported';

/** `bytes 0-511/12345` → 12345. */
export function totalOf(contentRange: string | undefined): number | null {
  if (contentRange === undefined) return null;
  const total = contentRange.split('/')[1];
  if (total === undefined) return null;
  const parsed = Number(total);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The leading bytes decide. A ZIP starts with a local header, or with its end
 * record when it is empty; gzip has a two-byte magic; a tar carries `ustar` at
 * offset 257, which is why the sniff reads a whole 512-byte block.
 */
export function sniffFormat(head: Buffer, totalBytes: number): SniffedFormat {
  if (head.length >= 4) {
    const signature = head.readUInt32LE(0);
    if (signature === LOCAL_HEADER_SIGNATURE || signature === EOCD_SIGNATURE) return 'zip';
  }
  if (head.length >= 2 && head.readUInt16BE(0) === GZIP_MAGIC) return 'gzip';
  if (
    totalBytes >= TAR_BLOCK_SIZE &&
    head.length >= TAR_MAGIC_OFFSET + 5 &&
    head.subarray(TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + 5).toString('latin1') === 'ustar'
  ) {
    return 'tar';
  }
  return 'unsupported';
}

interface CentralDirectoryLocation {
  readonly offset: number;
  readonly size: number;
  readonly entries: number;
}

/**
 * Finds the end-of-central-directory record in the object's tail and reads the
 * central directory's position from it, following the ZIP64 records when the
 * 32-bit fields are saturated.
 *
 * Searched backwards because the record sits at the very end unless the file has a
 * trailing comment, and the first match from the end is the real one — a comment
 * may itself contain the signature bytes.
 */
export function locateCentralDirectory(
  tail: Buffer,
  tailStart: number,
): CentralDirectoryLocation | null {
  for (let at = tail.length - EOCD_FIXED_SIZE; at >= 0; at -= 1) {
    if (tail.readUInt32LE(at) !== EOCD_SIGNATURE) continue;

    const commentLength = tail.readUInt16LE(at + 20);
    if (at + EOCD_FIXED_SIZE + commentLength !== tail.length) continue;

    const entries = tail.readUInt16LE(at + 10);
    const size = tail.readUInt32LE(at + 12);
    const offset = tail.readUInt32LE(at + 16);

    const needsZip64 =
      offset === ZIP64_SENTINEL_32 || size === ZIP64_SENTINEL_32 || entries === 0xffff;
    if (!needsZip64) return { offset, size, entries };

    const zip64 = readZip64(tail, at, tailStart);
    return zip64 ?? { offset, size, entries };
  }
  return null;
}

/**
 * The ZIP64 end record, reached through the locator that sits immediately before
 * the 32-bit one. Both are looked for inside the tail already read; an archive
 * whose locator falls outside it is beyond what a preview should chase.
 */
function readZip64(
  tail: Buffer,
  eocdAt: number,
  tailStart: number,
): CentralDirectoryLocation | null {
  const locatorAt = eocdAt - 20;
  if (locatorAt < 0) return null;
  if (tail.readUInt32LE(locatorAt) !== EOCD64_LOCATOR_SIGNATURE) return null;

  const absolute = Number(tail.readBigUInt64LE(locatorAt + 8));
  const relative = absolute - tailStart;
  if (relative < 0 || relative + 56 > tail.length) return null;
  if (tail.readUInt32LE(relative) !== EOCD64_SIGNATURE) return null;

  return {
    entries: Number(tail.readBigUInt64LE(relative + 32)),
    size: Number(tail.readBigUInt64LE(relative + 40)),
    offset: Number(tail.readBigUInt64LE(relative + 48)),
  };
}

export function parseCentralDirectory(
  central: Buffer,
  limit: number,
): { entries: ArchiveEntry[]; truncated: boolean } {
  const entries: ArchiveEntry[] = [];
  let at = 0;

  while (at + CENTRAL_HEADER_FIXED_SIZE <= central.length) {
    if (central.readUInt32LE(at) !== CENTRAL_HEADER_SIGNATURE) break;

    const nameLength = central.readUInt16LE(at + 28);
    const extraLength = central.readUInt16LE(at + 30);
    const commentLength = central.readUInt16LE(at + 32);
    const headerEnd = at + CENTRAL_HEADER_FIXED_SIZE + nameLength + extraLength + commentLength;
    if (headerEnd > central.length) return { entries, truncated: true };

    if (entries.length >= limit) return { entries, truncated: true };

    const nameStart = at + CENTRAL_HEADER_FIXED_SIZE;
    const path = central.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const extra = central.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);

    const compressed32 = central.readUInt32LE(at + 20);
    const uncompressed32 = central.readUInt32LE(at + 24);
    const zip64 = readZip64Extra(extra);

    const size = uncompressed32 === ZIP64_SENTINEL_32 ? (zip64.uncompressed ?? 0) : uncompressed32;
    const compressedSize =
      compressed32 === ZIP64_SENTINEL_32 ? (zip64.compressed ?? null) : compressed32;

    entries.push({
      path,
      size,
      compressedSize,
      modified: dosDateToIso(central.readUInt16LE(at + 12), central.readUInt16LE(at + 14)),
      // A directory entry is written with a trailing slash by every writer; the
      // external-attribute bit is a DOS-only fallback for the ones that do not.
      dir: path.endsWith('/') || (central.readUInt32LE(at + 38) & 0x10) !== 0,
    });

    at = headerEnd;
  }

  return { entries, truncated: false };
}

/** The 8-byte sizes, present only when a 32-bit field was saturated. */
function readZip64Extra(extra: Buffer): {
  uncompressed: number | null;
  compressed: number | null;
} {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const size = extra.readUInt16LE(at + 2);
    const dataAt = at + 4;
    if (dataAt + size > extra.length) break;

    if (id === ZIP64_EXTRA_ID) {
      const uncompressed = size >= 8 ? Number(extra.readBigUInt64LE(dataAt)) : null;
      const compressed = size >= 16 ? Number(extra.readBigUInt64LE(dataAt + 8)) : null;
      return { uncompressed, compressed };
    }
    at = dataAt + size;
  }
  return { uncompressed: null, compressed: null };
}

/**
 * The DOS date/time pair ZIP stores: two-second resolution, no timezone, and a year
 * counted from 1980. `null` for the zero value some writers leave behind, because
 * "1980-01-01" would be presented as a real date.
 */
export function dosDateToIso(time: number, date: number): string | null {
  if (date === 0) return null;
  const year = 1980 + ((date >> 9) & 0x7f);
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hours = (time >> 11) & 0x1f;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // DOS timestamps carry no zone; treating them as UTC is the conventional reading
  // and is at least consistent, which a guessed local offset would not be.
  const at = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/* --------------------------------- tar ---------------------------- */

const TAR_TYPE_DIRECTORY = '5';
const TAR_TYPE_GNU_LONG_NAME = 'L';
const TAR_TYPE_PAX_NEXT = 'x';
const TAR_TYPE_PAX_GLOBAL = 'g';
const TAR_FILE_TYPES = new Set(['0', '\0', '', '7']);

/**
 * Walks the tar's headers, skipping each entry's payload, until the limit or the
 * byte budget is reached.
 *
 * A tar has no index: its entries are 512-byte headers interleaved with the data,
 * so listing one means reading from the start. The read is bounded and reports
 * `truncated` rather than running to the end of a large archive.
 */
export async function scanTar(source: Readable, limit: number): Promise<ArchiveEntriesResponse> {
  const scanner = new TarScanner(limit);
  let consumed = 0;

  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    consumed += bytes.length;
    scanner.push(bytes);

    if (scanner.ended) break;
    if (consumed >= MAX_TAR_SCAN_BYTES) {
      scanner.giveUp();
      break;
    }
  }

  return { format: 'tar', entries: scanner.entries, truncated: scanner.truncated };
}

/**
 * The tar reader's state, fed whatever arrives.
 *
 * It is a class rather than a loop with flags because a tar is a genuine state
 * machine — "need a header", "skip a payload", "collect a payload" — and each state
 * needs the bytes left over from the last chunk. Written inline it is five levels of
 * nesting; written this way each step is three lines and reads as itself.
 *
 * Long names are the reason `collect` exists: GNU's `L` entry and pax's `x` entry
 * both carry the real path in a payload, and a path truncated at 100 characters in a
 * preview would be worse than not listing the entry at all.
 */
class TarScanner {
  readonly entries: ArchiveEntry[] = [];
  truncated = false;
  ended = false;

  private buffer: Buffer = Buffer.alloc(0);
  private skipRemaining = 0;
  private collectRemaining = 0;
  private collectPadding = 0;
  private collected: Buffer[] = [];
  private collectKind: 'long-name' | 'pax' | null = null;
  private pendingLongName: string | null = null;

  constructor(private readonly limit: number) {}

  push(bytes: Buffer): void {
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);
    while (!this.ended && this.step()) {
      // Each step consumes one state's worth of bytes; `false` means "need more".
    }
  }

  /** The byte budget ran out — whatever was read is still worth showing. */
  giveUp(): void {
    this.truncated = true;
    this.ended = true;
  }

  /** `false` when the next step needs bytes that have not arrived yet. */
  private step(): boolean {
    if (this.collectKind !== null) return this.stepCollect();
    if (this.skipRemaining > 0) return this.stepSkip();
    return this.stepHeader();
  }

  private stepCollect(): boolean {
    if (this.collectRemaining > 0) {
      const taken = this.take(this.collectRemaining);
      this.collected.push(taken);
      this.collectRemaining -= taken.length;
      if (this.collectRemaining > 0) return false;
    }
    if (this.collectPadding > 0) {
      this.collectPadding -= this.take(this.collectPadding).length;
      if (this.collectPadding > 0) return false;
    }

    const text = Buffer.concat(this.collected).toString('utf8');
    this.collected = [];
    this.pendingLongName = this.collectKind === 'pax' ? paxPath(text) : trimTrailingNul(text);
    this.collectKind = null;
    return true;
  }

  private stepSkip(): boolean {
    this.skipRemaining -= this.take(this.skipRemaining).length;
    return this.skipRemaining === 0;
  }

  private stepHeader(): boolean {
    if (this.buffer.length < TAR_BLOCK_SIZE) return false;
    const header = this.take(TAR_BLOCK_SIZE);

    // A zero block ends the archive (the format writes two; one is proof enough).
    if (header.every((byte) => byte === 0)) {
      this.ended = true;
      return false;
    }

    const size = parseOctal(header.subarray(124, 136));
    const payload = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    const type = header.subarray(156, 157).toString('latin1');

    if (type === TAR_TYPE_GNU_LONG_NAME || type === TAR_TYPE_PAX_NEXT) {
      this.collectKind = type === TAR_TYPE_GNU_LONG_NAME ? 'long-name' : 'pax';
      this.collectRemaining = size;
      this.collectPadding = payload - size;
      return true;
    }

    this.skipRemaining = payload;
    // A pax global header applies to the archive and names no entry.
    if (type !== TAR_TYPE_PAX_GLOBAL) this.record(header, type, size);
    return true;
  }

  private record(header: Buffer, type: string, size: number): void {
    const isDirectory = type === TAR_TYPE_DIRECTORY;
    if (!isDirectory && !TAR_FILE_TYPES.has(type)) {
      // A link, a device node, a sparse-file extension: not a listable entry, and
      // any long name that was read belonged to it.
      this.pendingLongName = null;
      return;
    }

    if (this.entries.length >= this.limit) {
      this.giveUp();
      return;
    }

    const path = this.pendingLongName ?? tarName(header);
    this.pendingLongName = null;
    this.entries.push({
      path,
      size: isDirectory ? 0 : size,
      // tar records only the stored size; there is no per-entry compression.
      compressedSize: null,
      modified: tarModified(header),
      dir: isDirectory || path.endsWith('/'),
    });
  }

  /** Up to `count` bytes off the front, advancing the buffer. */
  private take(count: number): Buffer {
    const taken = this.buffer.subarray(0, Math.min(count, this.buffer.length));
    this.buffer = this.buffer.subarray(taken.length);
    return taken;
  }
}

const trimTrailingNul = (text: string): string => text.replace(/\0+$/, '');

/** `ustar` splits a long path into a 155-byte prefix and a 100-byte name. */
export function tarName(header: Buffer): string {
  const name = trimNul(header.subarray(0, 100));
  const magic = header.subarray(TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + 5).toString('latin1');
  if (magic !== 'ustar') return name;
  const prefix = trimNul(header.subarray(345, 500));
  return prefix.length === 0 ? name : `${prefix}/${name}`;
}

function tarModified(header: Buffer): string | null {
  const seconds = parseOctal(header.subarray(136, 148));
  if (seconds <= 0) return null;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** A pax record is `<length> path=<value>\n`; only `path` matters here. */
export function paxPath(text: string): string | null {
  for (const line of text.split('\n')) {
    const separator = line.indexOf(' ');
    if (separator < 0) continue;
    const record = line.slice(separator + 1);
    if (record.startsWith('path=')) return record.slice('path='.length);
  }
  return null;
}

/** tar numbers are NUL- or space-terminated octal; a blank field means zero. */
export function parseOctal(field: Buffer): number {
  const text = trimNul(field).trim();
  if (text.length === 0) return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

const trimNul = (buffer: Buffer): string => {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end < 0 ? buffer.length : end).toString('utf8');
};
