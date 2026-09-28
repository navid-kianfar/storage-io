import { describe, expect, it } from 'vitest';
import type { ListObjectsResponse, ObjectItem } from '@storage-io/contracts';
import { filterEntries, flattenPages, listingTotals } from './entries';
import { keysToGlob } from './keysToGlob';
import { fileKind, guessContentType } from './fileKind';

function object(key: string, size = 10): ObjectItem {
  return {
    key,
    size,
    lastModified: '2026-09-27T10:00:00.000Z',
    etag: '"abc"',
    storageClass: 'STANDARD',
    versionId: null,
    isLatest: true,
    deleteMarker: false,
  };
}

function page(
  prefixes: readonly string[],
  objects: readonly ObjectItem[],
  nextCursor: string | null = null,
): ListObjectsResponse {
  return { prefixes: prefixes.map((prefix) => ({ prefix })), objects: [...objects], nextCursor };
}

describe('flattenPages', () => {
  it('puts folders before files and keeps one entry per key across pages', () => {
    const pages = [
      page(['raw/'], [object('raw.jpg')], '1'),
      // The API repeats a prefix on a later page when it straddles the cursor.
      page(['raw/'], [object('raw.jpg'), object('notes.txt')]),
    ];

    const entries = flattenPages(pages, '');

    expect(entries.map((entry) => entry.name)).toEqual(['raw', 'raw.jpg', 'notes.txt']);
    expect(entries[0]?.kind).toBe('prefix');
  });

  it('drops the prefix marker object, which is the folder itself', () => {
    // Some providers return the empty object that stands for the folder.
    const entries = flattenPages([page([], [object('2026/09/', 0), object('2026/09/a.jpg')])], '2026/09/');

    expect(entries.map((entry) => entry.name)).toEqual(['a.jpg']);
  });
});

describe('filterEntries', () => {
  const entries = flattenPages(
    [page(['raw/'], [object('hero.jpg'), object('notes.txt'), object('clip.mp4')])],
    '',
  );

  it('matches on the name, not the whole key', () => {
    expect(filterEntries(entries, new Set(), 'HERO').map((entry) => entry.name)).toEqual(['hero.jpg']);
  });

  it('never hides a folder behind a type filter, because it may contain matches', () => {
    const images = filterEntries(entries, new Set(['image'] as const), '');
    expect(images.map((entry) => entry.name)).toEqual(['raw', 'hero.jpg']);
  });

  it('treats an empty type filter as "no filter", not "nothing"', () => {
    expect(filterEntries(entries, new Set(), '')).toHaveLength(4);
  });
});

describe('listingTotals', () => {
  it('sums only the objects, since a folder has no size of its own', () => {
    const entries = flattenPages([page(['raw/'], [object('a', 100), object('b', 50)])], '');
    expect(listingTotals(entries)).toEqual({ count: 3, sizeBytes: 150 });
  });
});

describe('keysToGlob', () => {
  it('expresses a selection as one alternation', () => {
    expect(keysToGlob(['raw/a.jpg', 'raw/b.png'])).toBe('{raw/a.jpg,raw/b.png}');
  });

  it('does not wrap a single key, which needs no alternation', () => {
    expect(keysToGlob(['raw/a.jpg'])).toBe('raw/a.jpg');
  });

  it('escapes the glob metacharacters a key is allowed to contain', () => {
    // Without escaping, `report{1,2}.csv` would match two other keys instead.
    expect(keysToGlob(['report{1,2}.csv', 'b*.txt'])).toBe(
      '{report\\{1\\,2\\}.csv,b\\*.txt}',
    );
  });
});

describe('fileKind', () => {
  it('trusts the content type over the extension', () => {
    expect(fileKind('archive.zip', 'text/plain')).toBe('text');
  });

  it('falls back to the extension, which is all a listing row has', () => {
    expect(fileKind('clip.mp4')).toBe('video');
    expect(fileKind('notes.md')).toBe('text');
    expect(fileKind('bundle.tar.gz')).toBe('archive');
    expect(fileKind('mystery.xyz')).toBe('other');
  });

  it('calls a trailing slash a folder whatever the name suggests', () => {
    expect(fileKind('backup.zip/')).toBe('folder');
  });

  it('guesses a content type only for extensions it knows', () => {
    expect(guessContentType('a.json')).toBe('application/json');
    expect(guessContentType('a.unknown')).toBeNull();
  });
});
