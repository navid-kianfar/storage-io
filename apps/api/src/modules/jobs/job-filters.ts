import { compileGlob, type JobFilters } from '@storage-io/contracts';

/**
 * Deciding which objects a job touches.
 *
 * Every filter except `tags` is answerable from the listing page S3 already
 * returned — key, size, last-modified — so they cost nothing. `tags` needs a
 * `GetObjectTagging` per object, which is why `needsTags` exists: a job with no
 * tag filter must never make that call, and a job with one pays for it only on
 * the objects that survived the cheap filters.
 *
 * Pure and exported for the unit test: this is the code that decides whether an
 * operator's "delete everything over 1 GB modified before March" removes the
 * right objects, and it should be provable without a storage server.
 */

export interface JobCandidate {
  readonly key: string;
  readonly size: number;
  /** ISO-8601, or null where the listing did not report one. */
  readonly lastModified: string | null;
  readonly versionId?: string;
  /** Versioned listings only: whether this is the key's current version. */
  readonly isLatest?: boolean;
  /** Versioned listings only: a tombstone rather than an object. */
  readonly isDeleteMarker?: boolean;
}

/** A compiled filter set, so a glob is parsed once per job rather than per key. */
export interface CompiledJobFilters {
  readonly prefix: string;
  readonly modifiedAfterMs: number | null;
  readonly modifiedBeforeMs: number | null;
  readonly minSize: number | null;
  readonly maxSize: number | null;
  readonly glob: RegExp | null;
  readonly tags: readonly (readonly [string, string])[];
}

export function compileFilters(filters: JobFilters): CompiledJobFilters {
  return {
    prefix: filters.prefix,
    modifiedAfterMs: parseOrNull(filters.modifiedAfter),
    modifiedBeforeMs: parseOrNull(filters.modifiedBefore),
    minSize: filters.minSize,
    maxSize: filters.maxSize,
    glob: filters.glob === null || filters.glob.length === 0 ? null : compileGlob(filters.glob),
    tags: Object.entries(filters.tags),
  };
}

/** True when the job has a tag filter, so tags must be fetched per object. */
export const needsTags = (filters: CompiledJobFilters): boolean => filters.tags.length > 0;

/**
 * The filters answerable from the listing alone. A candidate that fails here is
 * never fetched for tags, which is the whole point of splitting the two.
 */
export function matchesListingFilters(
  filters: CompiledJobFilters,
  candidate: JobCandidate,
): boolean {
  if (filters.prefix.length > 0 && !candidate.key.startsWith(filters.prefix)) return false;
  if (filters.minSize !== null && candidate.size < filters.minSize) return false;
  if (filters.maxSize !== null && candidate.size > filters.maxSize) return false;

  if (filters.modifiedAfterMs !== null || filters.modifiedBeforeMs !== null) {
    // An object whose last-modified the listing did not report cannot satisfy a
    // date filter. Including it would be the silent wrong answer; excluding it is
    // the visible one, and the job log says so.
    if (candidate.lastModified === null) return false;
    const modifiedMs = Date.parse(candidate.lastModified);
    if (Number.isNaN(modifiedMs)) return false;
    if (filters.modifiedAfterMs !== null && modifiedMs < filters.modifiedAfterMs) return false;
    if (filters.modifiedBeforeMs !== null && modifiedMs > filters.modifiedBeforeMs) return false;
  }

  // The glob is matched against the whole key, not the part after the prefix: an
  // operator writing `logs/*.gz` means the key, and `/` is an ordinary character
  // in the shared matcher for exactly this reason.
  if (filters.glob !== null && !filters.glob.test(candidate.key)) return false;

  return true;
}

/** Every named tag must be present with the given value. */
export function matchesTagFilter(
  filters: CompiledJobFilters,
  tags: Readonly<Record<string, string>>,
): boolean {
  return filters.tags.every(([key, value]) => tags[key] === value);
}

/* ------------------------------ helpers --------------------------- */

function parseOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
