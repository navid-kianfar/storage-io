import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipArchive } from 'archiver';
import {
  dosDateToIso,
  locateCentralDirectory,
  parseCentralDirectory,
  parseOctal,
  paxPath,
  scanTar,
  sniffFormat,
  tarName,
  totalOf,
} from '../../src/modules/objects/archive-reader.service';

/**
 * The archive readers, tested against archives built here rather than fixtures on
 * disk — a fixture only proves the one writer that made it, and the point of this
 * code is reading whatever a ZIP or tar writer produced.
 */

/** A real ZIP, built in memory by the same library the download endpoint uses. */
async function buildZip(entries: readonly { name: string; body: string }[]): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 0 } });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve());
    archive.on('error', reject);
  });

  for (const entry of entries) {
    archive.append(Buffer.from(entry.body), {
      name: entry.name,
      date: new Date('2026-03-04T05:06:08Z'),
    });
  }
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** A tar, written by hand so the header fields are exactly what is asserted. */
function tarHeader(options: {
  name: string;
  size: number;
  type: string;
  mtime?: number;
  prefix?: string;
}): Buffer {
  const block = Buffer.alloc(512);
  block.write(options.name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'latin1');
  block.write(`${options.size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  block.write(`${(options.mtime ?? 0).toString(8).padStart(11, '0')}\0`, 136, 12, 'latin1');
  block.write(options.type, 156, 1, 'latin1');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  if (options.prefix !== undefined) block.write(options.prefix, 345, 155, 'utf8');
  return block;
}

function tarEntry(name: string, body: string, type = '0', prefix?: string): Buffer {
  const payload = Buffer.from(body);
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512);
  const header = tarHeader({
    name,
    size: payload.length,
    type,
    mtime: 1_772_000_000,
    ...(prefix === undefined ? {} : { prefix }),
  });
  return Buffer.concat([header, payload, padding]);
}

const tarEnd = (): Buffer => Buffer.alloc(1024);

describe('sniffFormat', () => {
  it('recognises a ZIP by its local file header', async () => {
    const zip = await buildZip([{ name: 'a.txt', body: 'hello' }]);
    expect(sniffFormat(zip.subarray(0, 512), zip.length)).toBe('zip');
  });

  it('recognises gzip', () => {
    const gz = gzipSync(Buffer.from('anything'));
    expect(sniffFormat(gz.subarray(0, 512), gz.length)).toBe('gzip');
  });

  it('recognises a tar by its ustar magic at offset 257', () => {
    const tar = Buffer.concat([tarEntry('a.txt', 'hi'), tarEnd()]);
    expect(sniffFormat(tar.subarray(0, 512), tar.length)).toBe('tar');
  });

  it('reports anything else as unsupported, rather than guessing', () => {
    // The preview pane asks about every object the operator opens, so "not an
    // archive" has to be an answer and not an error.
    expect(sniffFormat(Buffer.from('just some text, not an archive at all'), 36)).toBe(
      'unsupported',
    );
    expect(sniffFormat(Buffer.alloc(0), 0)).toBe('unsupported');
  });

  it('does not call a short file a tar, because the magic would be out of range', () => {
    expect(sniffFormat(Buffer.from('PK'), 2)).toBe('unsupported');
  });
});

describe('reading a real ZIP central directory', () => {
  it('lists every entry with its size and modification time', async () => {
    const zip = await buildZip([
      { name: 'docs/readme.md', body: '# hello' },
      { name: 'data/rows.csv', body: 'a,b,c\n1,2,3\n' },
    ]);

    const located = locateCentralDirectory(zip, 0);
    expect(located).not.toBeNull();

    const parsed = parseCentralDirectory(
      zip.subarray(located?.offset ?? 0, (located?.offset ?? 0) + (located?.size ?? 0)),
      500,
    );

    expect(parsed.truncated).toBe(false);
    expect(parsed.entries.map((entry) => entry.path)).toEqual(['docs/readme.md', 'data/rows.csv']);
    expect(parsed.entries[0]?.size).toBe('# hello'.length);
    expect(parsed.entries[1]?.size).toBe('a,b,c\n1,2,3\n'.length);
    // Stored with no compression, so the compressed size is the same.
    expect(parsed.entries[0]?.compressedSize).toBe('# hello'.length);
    expect(parsed.entries[0]?.modified).toMatch(/^2026-03-04T/);
    expect(parsed.entries.every((entry) => !entry.dir)).toBe(true);
  });

  it('marks a directory entry as one', async () => {
    const zip = await buildZip([{ name: 'folder/', body: '' }]);
    const located = locateCentralDirectory(zip, 0);
    const parsed = parseCentralDirectory(
      zip.subarray(located?.offset ?? 0, (located?.offset ?? 0) + (located?.size ?? 0)),
      500,
    );
    expect(parsed.entries[0]).toMatchObject({ path: 'folder/', dir: true });
  });

  it('honours the entry limit and says it truncated', async () => {
    const zip = await buildZip(
      Array.from({ length: 10 }, (_, index) => ({ name: `f${index}.txt`, body: 'x' })),
    );
    const located = locateCentralDirectory(zip, 0);
    const parsed = parseCentralDirectory(
      zip.subarray(located?.offset ?? 0, (located?.offset ?? 0) + (located?.size ?? 0)),
      3,
    );
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.truncated).toBe(true);
  });

  it('finds the end record when the tail is read as a window, not from zero', async () => {
    // This is how the service reads it: a ranged GET of the last N bytes, whose
    // offsets are relative to the window rather than the file.
    const zip = await buildZip([{ name: 'a.txt', body: 'hello' }]);
    const tailStart = Math.max(0, zip.length - 128);
    const located = locateCentralDirectory(zip.subarray(tailStart), tailStart);
    expect(located?.entries).toBe(1);
    expect(located?.offset).toBeLessThan(zip.length);
  });

  it('reports no location for something that is not a ZIP at all', () => {
    expect(locateCentralDirectory(Buffer.alloc(64), 0)).toBeNull();
  });
});

describe('scanTar', () => {
  it('lists files and directories with their sizes', async () => {
    const tar = Buffer.concat([
      tarEntry('dir/', '', '5'),
      tarEntry('dir/one.txt', 'first'),
      tarEntry('two.txt', 'second body'),
      tarEnd(),
    ]);

    const result = await scanTar(Readable.from([tar]), 500);
    expect(result.format).toBe('tar');
    expect(result.truncated).toBe(false);
    expect(result.entries).toEqual([
      { path: 'dir/', size: 0, compressedSize: null, modified: expect.any(String), dir: true },
      {
        path: 'dir/one.txt',
        size: 5,
        compressedSize: null,
        modified: expect.any(String),
        dir: false,
      },
      {
        path: 'two.txt',
        size: 11,
        compressedSize: null,
        modified: expect.any(String),
        dir: false,
      },
    ]);
  });

  it('reassembles a ustar prefix into the full path', async () => {
    const tar = Buffer.concat([tarEntry('deep.txt', 'x', '0', 'a/very/long/prefix'), tarEnd()]);
    const result = await scanTar(Readable.from([tar]), 500);
    expect(result.entries[0]?.path).toBe('a/very/long/prefix/deep.txt');
  });

  it('uses a GNU long-name entry instead of the truncated header name', async () => {
    const longName = `${'nested/'.repeat(20)}file.txt`;
    const tar = Buffer.concat([
      tarEntry('././@LongLink', `${longName}\0`, 'L'),
      tarEntry(longName.slice(0, 100), 'body'),
      tarEnd(),
    ]);

    const result = await scanTar(Readable.from([tar]), 500);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toBe(longName);
  });

  it('uses a pax path record', async () => {
    const longName = 'pax/very/long/path/file.txt';
    // A pax record is "<total length> <key>=<value>\n"; the reader only needs the
    // space and the key, so the length is written the way GNU tar writes it.
    const body = `path=${longName}\n`;
    const record = `${body.length + 4} ${body}`;
    const tar = Buffer.concat([
      tarEntry('PaxHeaders/0', record, 'x'),
      tarEntry('short.txt', 'body'),
      tarEnd(),
    ]);

    const result = await scanTar(Readable.from([tar]), 500);
    expect(result.entries[0]?.path).toBe(longName);
  });

  it('works when the archive arrives in chunks that split headers', async () => {
    // A real stream gives 64 KiB chunks that land wherever they land; the scanner
    // has to carry a partial header across them.
    const tar = Buffer.concat([
      tarEntry('a.txt', 'a'.repeat(700)),
      tarEntry('b.txt', 'b'),
      tarEnd(),
    ]);
    const chunks: Buffer[] = [];
    for (let at = 0; at < tar.length; at += 37) chunks.push(tar.subarray(at, at + 37));

    const result = await scanTar(Readable.from(chunks), 500);
    expect(result.entries.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt']);
    expect(result.entries[0]?.size).toBe(700);
  });

  it('skips a link entry, which is not a listable file', async () => {
    const tar = Buffer.concat([tarEntry('link', '', '2'), tarEntry('real.txt', 'body'), tarEnd()]);
    const result = await scanTar(Readable.from([tar]), 500);
    expect(result.entries.map((entry) => entry.path)).toEqual(['real.txt']);
  });

  it('stops at the limit and says it truncated', async () => {
    const tar = Buffer.concat([
      ...Array.from({ length: 6 }, (_, index) => tarEntry(`f${index}.txt`, 'x')),
      tarEnd(),
    ]);
    const result = await scanTar(Readable.from([tar]), 2);
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('stops at the first zero block rather than reading padding as entries', async () => {
    const tar = Buffer.concat([tarEntry('a.txt', 'x'), tarEnd(), Buffer.alloc(4096)]);
    const result = await scanTar(Readable.from([tar]), 500);
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });
});

describe('tar field parsing', () => {
  it('reads NUL- and space-terminated octal', () => {
    expect(parseOctal(Buffer.from('0000755\0', 'latin1'))).toBe(0o755);
    expect(parseOctal(Buffer.from('00000000144 ', 'latin1'))).toBe(100);
  });

  it('reads a blank or nonsense field as zero rather than NaN', () => {
    expect(parseOctal(Buffer.alloc(12))).toBe(0);
    expect(parseOctal(Buffer.from('        ', 'latin1'))).toBe(0);
    expect(parseOctal(Buffer.from('not-octal', 'latin1'))).toBe(0);
  });

  it('takes the name alone when there is no ustar prefix', () => {
    const header = tarHeader({ name: 'plain.txt', size: 0, type: '0' });
    expect(tarName(header)).toBe('plain.txt');
  });

  it('finds the path record in a pax block', () => {
    expect(paxPath('30 path=some/long/name.txt\n')).toBe('some/long/name.txt');
    expect(paxPath('20 mtime=1700000000\n')).toBeNull();
    expect(paxPath('')).toBeNull();
  });
});

describe('dosDateToIso', () => {
  it('converts the DOS pair, which has two-second resolution', () => {
    // 2026-03-04 05:06:08 → date = ((2026-1980)<<9)|(3<<5)|4, time = (5<<11)|(6<<5)|4
    const date = ((2026 - 1980) << 9) | (3 << 5) | 4;
    const time = (5 << 11) | (6 << 5) | 4;
    expect(dosDateToIso(time, date)).toBe('2026-03-04T05:06:08.000Z');
  });

  it('is null for the zero some writers leave behind', () => {
    // Otherwise the pane shows "1980-01-01" as if it were a real timestamp.
    expect(dosDateToIso(0, 0)).toBeNull();
  });

  it('is null for an impossible month or day', () => {
    expect(dosDateToIso(0, (1 << 9) | (13 << 5) | 1)).toBeNull();
    expect(dosDateToIso(0, (1 << 9) | (1 << 5) | 0)).toBeNull();
  });
});

describe('totalOf', () => {
  it('reads the object size out of a Content-Range header', () => {
    expect(totalOf('bytes 0-511/12345')).toBe(12345);
  });

  it('is null when the header is absent or unparseable', () => {
    expect(totalOf(undefined)).toBeNull();
    expect(totalOf('bytes 0-511/*')).toBeNull();
  });
});
