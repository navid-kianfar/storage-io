import { Injectable } from '@nestjs/common';
import {
  GetObjectTaggingCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  type ListObjectVersionsCommandOutput,
  type ListObjectsV2CommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  compileFilters,
  matchesListingFilters,
  matchesTagFilter,
  needsTags,
  type CompiledJobFilters,
  type JobCandidate,
} from './job-filters';
import type { JobFilters } from '@storage-io/contracts';

/**
 * The stream of objects a job works through.
 *
 * It yields **pages**, not objects, and that is what makes resume exact: the
 * engine finishes a whole page before it persists the page's continuation token,
 * so a restart re-reads at most one page and never skips one. Yielding objects
 * and persisting a token per object would mean tracking which of a page's keys
 * had completed, which is a second checkpoint format nobody needs.
 *
 * Tags are fetched only for candidates that survived the cheap filters, and only
 * when the job actually has a tag filter — `GetObjectTagging` is a request per
 * object, so a job that does not need it must not pay for it.
 */

/** S3's maximum, and the page size the engine checkpoints at. */
export const LIST_PAGE_SIZE = 1000;

export interface JobPage {
  readonly items: readonly JobCandidate[];
  /**
   * What to pass back to resume after this page. `null` means the listing is
   * finished; a non-null value is stored in `jobs.checkpoint`.
   */
  readonly nextToken: string | null;
  /** Objects the listing returned before filtering — what "scanned" counts. */
  readonly scanned: number;
}

export interface JobSourceRequest {
  readonly client: S3Client;
  readonly bucket: string;
  readonly filters: JobFilters;
  /** Walk every version and delete marker instead of only current objects. */
  readonly includeVersions: boolean;
  /** `jobs.checkpoint` from a previous run, or null to start at the beginning. */
  readonly startToken: string | null;
}

@Injectable()
export class JobSourceService {
  /**
   * The page size every listing here uses.
   *
   * Writable, and the only thing in this file that is: resume across a page
   * boundary cannot be proved with a single page, and forcing a real bucket to
   * hold more than a thousand objects for one assertion is a slower and less
   * exact test than turning the page size down. Nothing in `src/` writes it.
   */
  pageSize = LIST_PAGE_SIZE;

  /**
   * One page of matching objects. Called in a loop by the engine, which owns the
   * token: a generator holding the token would lose it on a pause.
   */
  async page(request: JobSourceRequest): Promise<JobPage> {
    const filters = compileFilters(request.filters);
    const raw = request.includeVersions
      ? await this.versionPage(request, filters)
      : await this.currentPage(request, filters);

    if (!needsTags(filters)) return raw;
    const kept = await this.filterByTags(request.client, request.bucket, raw.items, filters);
    return { items: kept, nextToken: raw.nextToken, scanned: raw.scanned };
  }

  /**
   * Explicit keys, for a job started from a selection in the object browser. They
   * are paged the same way so the engine's loop does not need a second shape, and
   * the filters still apply — an operator who picked 500 objects and then set a
   * size filter meant both.
   */
  keyPage(keys: readonly string[], offset: number): JobPage {
    const slice = keys.slice(offset, offset + this.pageSize);
    const items = slice.map((key): JobCandidate => ({ key, size: 0, lastModified: null }));
    const nextOffset = offset + slice.length;
    return {
      items,
      nextToken: nextOffset >= keys.length ? null : String(nextOffset),
      scanned: slice.length,
    };
  }

  /* ------------------------------ internals ----------------------- */

  private async currentPage(
    request: JobSourceRequest,
    filters: CompiledJobFilters,
  ): Promise<JobPage> {
    const response: ListObjectsV2CommandOutput = await request.client.send(
      new ListObjectsV2Command({
        Bucket: request.bucket,
        // The prefix is pushed to the server: it is the one filter S3 can apply,
        // and applying it here instead would list the whole bucket to throw most
        // of it away.
        Prefix: filters.prefix.length > 0 ? filters.prefix : undefined,
        MaxKeys: this.pageSize,
        ContinuationToken: request.startToken ?? undefined,
      }),
    );

    const contents = response.Contents ?? [];
    const items: JobCandidate[] = [];
    for (const entry of contents) {
      if (entry.Key === undefined) continue;
      // A "folder" placeholder is a zero-byte key ending in `/`; acting on one
      // achieves nothing and makes the counts confusing.
      if (entry.Key.endsWith('/') && (entry.Size ?? 0) === 0) continue;
      const candidate: JobCandidate = {
        key: entry.Key,
        size: entry.Size ?? 0,
        lastModified: entry.LastModified?.toISOString() ?? null,
      };
      if (matchesListingFilters(filters, candidate)) items.push(candidate);
    }

    const nextToken =
      response.IsTruncated === true ? (response.NextContinuationToken ?? null) : null;
    return { items, nextToken, scanned: contents.length };
  }

  /**
   * Versions and delete markers, for `includeVersions`. The continuation state is
   * two markers rather than one token, so they travel joined by a `\u0000` —
   * neither marker can contain it, and the engine only ever stores and replays the
   * string.
   */
  private async versionPage(
    request: JobSourceRequest,
    filters: CompiledJobFilters,
  ): Promise<JobPage> {
    const [keyMarker, versionMarker] = splitVersionToken(request.startToken);

    const response: ListObjectVersionsCommandOutput = await request.client.send(
      new ListObjectVersionsCommand({
        Bucket: request.bucket,
        Prefix: filters.prefix.length > 0 ? filters.prefix : undefined,
        MaxKeys: this.pageSize,
        KeyMarker: keyMarker,
        VersionIdMarker: versionMarker,
      }),
    );

    // Versions and delete markers arrive in separate arrays with different shapes
    // — a marker has no size — so each is mapped on its own rather than narrowed
    // out of a union.
    const versions = (response.Versions ?? []).map((entry): RawVersionEntry => ({
      key: entry.Key,
      size: entry.Size ?? 0,
      lastModified: entry.LastModified,
      versionId: entry.VersionId,
      isLatest: entry.IsLatest === true,
      isDeleteMarker: false,
    }));
    const markers = (response.DeleteMarkers ?? []).map((entry): RawVersionEntry => ({
      key: entry.Key,
      size: 0,
      lastModified: entry.LastModified,
      versionId: entry.VersionId,
      isLatest: entry.IsLatest === true,
      isDeleteMarker: true,
    }));
    const entries = [...versions, ...markers];

    const items: JobCandidate[] = [];
    for (const entry of entries) {
      if (entry.key === undefined) continue;
      const candidate: JobCandidate = {
        key: entry.key,
        size: entry.size,
        lastModified: entry.lastModified?.toISOString() ?? null,
        ...(entry.versionId === undefined ? {} : { versionId: entry.versionId }),
        isLatest: entry.isLatest,
        isDeleteMarker: entry.isDeleteMarker,
      };
      if (matchesListingFilters(filters, candidate)) items.push(candidate);
    }

    const nextToken =
      response.IsTruncated === true
        ? joinVersionToken(response.NextKeyMarker, response.NextVersionIdMarker)
        : null;
    return { items, nextToken, scanned: entries.length };
  }

  private async filterByTags(
    client: S3Client,
    bucket: string,
    items: readonly JobCandidate[],
    filters: CompiledJobFilters,
  ): Promise<readonly JobCandidate[]> {
    const kept: JobCandidate[] = [];
    for (const candidate of items) {
      const tags = await this.readTags(client, bucket, candidate);
      if (matchesTagFilter(filters, tags)) kept.push(candidate);
    }
    return kept;
  }

  /** An object whose tags cannot be read is treated as having none. */
  private async readTags(
    client: S3Client,
    bucket: string,
    candidate: JobCandidate,
  ): Promise<Record<string, string>> {
    try {
      const response = await client.send(
        new GetObjectTaggingCommand({
          Bucket: bucket,
          Key: candidate.key,
          ...(candidate.versionId === undefined ? {} : { VersionId: candidate.versionId }),
        }),
      );
      const tags: Record<string, string> = {};
      for (const tag of response.TagSet ?? []) {
        if (tag.Key === undefined) continue;
        tags[tag.Key] = tag.Value ?? '';
      }
      return tags;
    } catch {
      return {};
    }
  }
}

/* ------------------------------ helpers --------------------------- */

/** The two listing shapes flattened to one, before filters are applied. */
interface RawVersionEntry {
  readonly key: string | undefined;
  readonly size: number;
  readonly lastModified: Date | undefined;
  readonly versionId: string | undefined;
  readonly isLatest: boolean;
  readonly isDeleteMarker: boolean;
}

const VERSION_TOKEN_SEPARATOR = '\u0000';

export function joinVersionToken(
  keyMarker: string | undefined,
  versionMarker: string | undefined,
): string | null {
  if (keyMarker === undefined && versionMarker === undefined) return null;
  return `${keyMarker ?? ''}${VERSION_TOKEN_SEPARATOR}${versionMarker ?? ''}`;
}

export function splitVersionToken(
  token: string | null,
): readonly [string | undefined, string | undefined] {
  if (token === null) return [undefined, undefined];
  const [keyMarker = '', versionMarker = ''] = token.split(VERSION_TOKEN_SEPARATOR);
  return [
    keyMarker.length === 0 ? undefined : keyMarker,
    versionMarker.length === 0 ? undefined : versionMarker,
  ];
}
