import type { ListObjectsResponse, ObjectItem } from '@storage-io/contracts';
import { keyName } from './api';
import { fileKind, type FileKind } from './fileKind';

/**
 * One row of the listing. The API answers with two separate arrays — `prefixes`
 * (the folders at this level) and `objects` — and the browser shows them as one
 * list with folders first. Flattening them here, once, is what lets selection,
 * the row menu and the bulk bar treat both the same way.
 */

export type Entry =
  | {
      readonly id: string;
      readonly kind: 'prefix';
      readonly name: string;
      readonly prefix: string;
    }
  | {
      readonly id: string;
      readonly kind: 'object';
      readonly name: string;
      readonly object: ObjectItem;
      readonly fileKind: FileKind;
    };

/** `p:` and `o:` keep a folder and an object of the same name apart in a Set. */
export function entryId(entry: Entry): string {
  return entry.id;
}

export function isPrefixEntry(entry: Entry): entry is Extract<Entry, { kind: 'prefix' }> {
  return entry.kind === 'prefix';
}

export function flattenPages(
  pages: readonly ListObjectsResponse[],
  currentPrefix: string,
): readonly Entry[] {
  const folders: Entry[] = [];
  const files: Entry[] = [];
  const seenPrefixes = new Set<string>();
  const seenObjects = new Set<string>();

  for (const page of pages) {
    for (const item of page.prefixes) {
      if (seenPrefixes.has(item.prefix)) continue;
      seenPrefixes.add(item.prefix);
      folders.push({
        id: `p:${item.prefix}`,
        kind: 'prefix',
        name: keyName(item.prefix),
        prefix: item.prefix,
      });
    }
    for (const object of page.objects) {
      // With `delimiter=/` the API still returns the prefix marker itself as an
      // object on some providers; it is the folder, not a file inside it.
      if (object.key === currentPrefix) continue;
      const id = `o:${object.key}:${object.versionId ?? ''}`;
      if (seenObjects.has(id)) continue;
      seenObjects.add(id);
      files.push({
        id,
        kind: 'object',
        name: keyName(object.key),
        object,
        fileKind: fileKind(object.key),
      });
    }
  }

  return [...folders, ...files];
}

export interface ListingTotals {
  readonly count: number;
  readonly sizeBytes: number;
}

export function listingTotals(entries: readonly Entry[]): ListingTotals {
  let sizeBytes = 0;
  for (const entry of entries) {
    if (entry.kind !== 'object') continue;
    sizeBytes += entry.object.size;
  }
  return { count: entries.length, sizeBytes };
}

/**
 * The type filter from the toolbar. An empty set means "no filter", not "nothing":
 * a filter that hides everything by default would be a trap.
 */
export function filterEntries(
  entries: readonly Entry[],
  kinds: ReadonlySet<FileKind>,
  text: string,
): readonly Entry[] {
  const needle = text.trim().toLowerCase();
  return entries.filter((entry) => {
    if (needle !== '' && !entry.name.toLowerCase().includes(needle)) return false;
    if (kinds.size === 0) return true;
    // A folder is never hidden by a type filter: it may contain matching objects.
    if (entry.kind === 'prefix') return true;
    return kinds.has(entry.fileKind);
  });
}
