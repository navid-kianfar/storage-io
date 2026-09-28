import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  type BucketLocationConstraint,
  type ListObjectVersionsCommandOutput,
} from '@aws-sdk/client-s3';
import {
  QUOTA_THRESHOLD_DEFAULT,
  type Bucket,
  type BucketBulkRequest,
  type BucketBulkResponse,
  type BucketBulkResult,
  type BucketDetail,
  type BucketList,
  type CreateBucketRequest,
  type Job,
  type ListBucketsQuery,
  type PaginationQuery,
} from '@storage-io/contracts';
import { bulkMessageOf } from '../../common/errors/bulk-message';
import { BucketNotEmptyError, NotFoundError } from '../../common/errors/domain.exception';
import { mapProviderError } from '../../common/errors/provider-error.mapper';
import { ServerRepository } from '../../servers/server.repository';
import { BucketFactsService } from '../inventory/bucket-facts.service';
import { InventoryService } from '../inventory/inventory.service';
import { ObjectDeleteService } from '../objects/object-delete.service';
import { JOBS_PORT, type JobsPort } from '../jobs/jobs.port';
import { StorageContextService, type StorageContext } from '../storage/storage-context.service';
import { BucketSettingsService } from './bucket-settings.service';
import { toS3LifecycleRule } from './mappers/lifecycle.mapper';

/**
 * How many objects `DELETE …?force=true` will remove inline before it refuses.
 *
 * A force delete has to leave the operator with a definite answer — the bucket is
 * gone, or it is not — so it empties the bucket in the same request rather than
 * returning 204 while work continues in the background. That only holds while the
 * work fits in a request: past this many objects the honest answer is
 * `BUCKET_NOT_EMPTY` pointing at `POST …/empty`, which is the job-backed path.
 */
export const FORCE_DELETE_MAX_OBJECTS = 100_000;

/** Versions walked before `noncurrentVersions` is reported as unknown. */
const VERSION_COUNT_PAGE_BUDGET = 20;
const VERSION_PAGE_SIZE = 1000;

/** S3 rejects `LocationConstraint: 'us-east-1'`; it is the implicit default. */
const IMPLICIT_REGION = 'us-east-1';

/**
 * Buckets: the aggregated list, creation, the detail view, deletion and the bulk
 * actions. Per-bucket settings live in `BucketSettingsService`.
 *
 * The list is answered from the inventory cache, not from the servers: it spans
 * every server, and asking each one on every page load would make the slowest
 * server decide the page's latency and put an offline server's buckets out of the
 * list entirely. Everything this service *writes* is written to the cache too, so
 * the list never lags an action the operator just took.
 */
@Injectable()
export class BucketsService {
  private readonly logger = new Logger(BucketsService.name);

  constructor(
    private readonly storage: StorageContextService,
    private readonly inventory: InventoryService,
    private readonly facts: BucketFactsService,
    private readonly settings: BucketSettingsService,
    private readonly deleter: ObjectDeleteService,
    private readonly servers: ServerRepository,
    @Inject(JOBS_PORT) private readonly jobs: JobsPort,
  ) {}

  /* -------------------------------- list --------------------------- */

  list(query: ListBucketsQuery, page: PaginationQuery): BucketList {
    const filters = this.filtersOf(query);
    return {
      items: [...this.inventory.list(filters, page)],
      total: this.inventory.count(filters),
      summary: this.inventory.summary(filters),
    };
  }

  /** The same filtered set as `list`, streamed for the CSV export. */
  iterateForExport(query: ListBucketsQuery): Generator<Bucket> {
    return this.inventory.iterateForExport(this.filtersOf(query));
  }

  /* ------------------------------- create -------------------------- */

  /**
   * Creates the bucket, then applies the options that are separate S3 calls.
   *
   * Object lock is the one that cannot be added later — S3 accepts it only at
   * creation — so an unsupported provider is refused here rather than after the
   * bucket exists. Versioning, access and quota are all reversible, so a failure
   * in one of them leaves a created bucket and a reported error rather than an
   * attempt to roll the bucket back.
   */
  async create(sid: string, request: CreateBucketRequest): Promise<Bucket> {
    const context = this.storage.forServer(sid);
    if (request.objectLock) {
      this.storage.requireCapability(context, 'objectLock', 'object lock');
    }
    if (request.versioning) {
      this.storage.requireCapability(context, 'versioning', 'bucket versioning');
    }

    const region = request.region ?? context.row.region;
    await context.client.send(
      new CreateBucketCommand({
        Bucket: request.name,
        ...(region === IMPLICIT_REGION
          ? {}
          : {
              CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint },
            }),
        ...(request.objectLock ? { ObjectLockEnabledForBucket: true } : {}),
      }),
    );

    // Object lock turns versioning on by itself; asking for both is not an error.
    if (request.versioning && !request.objectLock) {
      await this.settings.setVersioning(sid, request.name, { status: 'enabled' });
    }
    if (request.access === 'public-read') {
      await this.settings.setAccess(sid, request.name, 'public-read');
    }
    if (request.quota !== null) {
      await this.settings.applyQuota(context, request.name, {
        limitBytes: request.quota.limitBytes,
        mode: request.quota.mode,
        threshold: QUOTA_THRESHOLD_DEFAULT,
      });
    }

    await this.inventory.refreshBucket(context, request.name, { justCreated: true });
    this.servers.update(context.row.id, { bucketCount: context.row.bucketCount + 1 });

    const created = this.inventory.cached(context.row.id, request.name);
    if (created === null)
      throw new NotFoundError(`The bucket "${request.name}" was not found after creation.`);

    this.logger.log({ server: context.row.name, bucket: request.name }, 'Bucket created');
    return created;
  }

  /* ------------------------------- detail -------------------------- */

  /**
   * `GET /buckets/:bucketId` — the resolve endpoint the web app navigates by.
   *
   * The id names a cached bucket; the detail is then read live from its server,
   * because the operator is about to edit these values. When the server cannot be
   * reached the cached row is returned instead of a 502: the page is still worth
   * showing, and `Bucket.unavailable` is how it says the numbers are the cache's.
   * A bucket the server no longer has is a 404, not a cached ghost.
   */
  async findById(bucketId: string): Promise<BucketDetail> {
    const located = this.inventory.locate(bucketId);
    if (located === null) throw new NotFoundError('No such bucket.');

    try {
      return await this.detail(located.serverId, located.name);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;

      const cached = this.inventory.cachedDetail(located.serverId, located.name);
      if (cached === null) throw error;

      this.logger.warn(
        { bucket: located.name, err: error instanceof Error ? error.message : String(error) },
        'Serving a bucket from the cache; its server could not be reached',
      );
      return cached;
    }
  }

  /**
   * The settings page's own view, read live rather than from the cache: the
   * operator is about to edit these values and a five-minute-old versioning state
   * is the wrong thing to show them. Sizes still come from the cache, because
   * counting a bucket is not something a page load can afford.
   */
  async detail(sid: string, bucket: string): Promise<BucketDetail> {
    const context = this.storage.forServer(sid);
    await this.requireBucket(context, bucket);

    const attributes = await this.facts.readAttributes(context.client, bucket);
    this.inventory.patch(context.row.id, bucket, {
      versioning: attributes.versioning,
      objectLock: attributes.objectLock,
      access: attributes.access,
      tags: attributes.tags,
      region: attributes.region,
    });

    const noncurrentVersions =
      attributes.versioning === 'off' ? 0 : await this.countNoncurrentVersions(context, bucket);
    this.inventory.patch(context.row.id, bucket, { noncurrentVersions });

    const detail = this.inventory.cachedDetail(context.row.id, bucket);
    if (detail === null) throw new NotFoundError(`No bucket named "${bucket}" on this server.`);
    return detail;
  }

  /* ------------------------------- delete -------------------------- */

  /**
   * Deletes the bucket. Without `force` it must still hold nothing.
   *
   * **The emptiness check is ours, not the provider's.** S3 and MinIO answer
   * `BucketNotEmpty`, but SeaweedFS 3.97 deletes a non-empty bucket and everything
   * in it without complaint — verified against the dev container. Relying on the
   * provider would therefore make `DELETE` silently destructive on one of the
   * supported backends, so the contract's 409 is enforced here for all of them.
   */
  async remove(sid: string, bucket: string, force: boolean): Promise<void> {
    const context = this.storage.forServer(sid);

    if (force) {
      await this.emptyInline(context, bucket);
    } else {
      await this.assertEmpty(context, bucket);
    }

    await context.client.send(new DeleteBucketCommand({ Bucket: bucket }));
    this.inventory.forget(context.row.id, bucket);
    this.logger.log({ server: context.row.name, bucket, force }, 'Bucket deleted');
  }

  /**
   * `POST …/empty` — always a job, whatever the size. Emptying is the operation
   * with no upper bound on how long it takes, and the contract returns a `Job` for
   * exactly that reason.
   */
  empty(sid: string, bucket: string, includeVersions: boolean): Job {
    const context = this.storage.forServer(sid);
    return this.jobs.enqueue({
      type: 'empty-bucket',
      source: { serverId: context.row.id, bucket },
      params: { includeVersions },
    });
  }

  /* -------------------------------- bulk --------------------------- */

  /**
   * One action over many buckets. Every bucket is attempted and reported on its
   * own row: a set where the third bucket is locked must still apply to the other
   * nine, which is what makes this different from a loop that throws.
   */
  async bulk(request: BucketBulkRequest): Promise<BucketBulkResponse> {
    const results: BucketBulkResult[] = [];

    for (const ref of request.buckets) {
      // Read before the action, so a `delete` row still carries the id the caller
      // navigated by — the cache row is gone by the time the result is built.
      const id = this.inventory.idOf(ref.serverId, ref.bucket);
      try {
        await this.applyBulkAction(request, ref.serverId, ref.bucket);
        results.push({ id, serverId: ref.serverId, bucket: ref.bucket, ok: true, message: null });
      } catch (error) {
        results.push({
          id,
          serverId: ref.serverId,
          bucket: ref.bucket,
          ok: false,
          message: bulkMessageOf(error),
        });
      }
    }

    return { results };
  }

  /* ------------------------------ internals ------------------------ */

  private async applyBulkAction(
    request: BucketBulkRequest,
    serverId: string,
    bucket: string,
  ): Promise<void> {
    switch (request.action) {
      case 'quota': {
        const context = this.storage.forServer(serverId);
        await this.settings.applyQuota(context, bucket, request.payload);
        return;
      }
      case 'lifecycle-rule': {
        await this.appendLifecycleRule(serverId, bucket, request.payload);
        return;
      }
      case 'tags': {
        await this.settings.setTags(serverId, bucket, request.payload);
        return;
      }
      case 'access': {
        await this.settings.setAccess(serverId, bucket, request.payload.access);
        return;
      }
      case 'delete': {
        await this.remove(serverId, bucket, request.payload.force);
        return;
      }
    }
  }

  /**
   * Adds one rule to whatever the bucket already has, replacing a rule with the
   * same id. A bulk "apply this lifecycle rule" that overwrote the existing
   * configuration would silently drop rules the operator never mentioned.
   */
  private async appendLifecycleRule(
    serverId: string,
    bucket: string,
    rule: Parameters<typeof toS3LifecycleRule>[0],
  ): Promise<void> {
    const current = await this.settings.getLifecycle(serverId, bucket);
    const kept = current.rules.filter((existing) => existing.id !== rule.id);
    await this.settings.setLifecycle(serverId, bucket, { rules: [...kept, rule] });
  }

  /**
   * One key — current or historical — is enough to refuse. `MaxKeys: 1` on both
   * listings, so the check costs two cheap calls and never walks the bucket.
   */
  private async assertEmpty(context: StorageContext, bucket: string): Promise<void> {
    const current = await context.client.send(
      new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }),
    );
    if ((current.Contents ?? []).length > 0) {
      throw new BucketNotEmptyError(
        `"${bucket}" still contains objects. Empty it first, or delete it with ?force=true.`,
      );
    }

    // A versioned bucket with only delete markers left lists no current objects but
    // still refuses to be removed, so the versions have to be checked too.
    const versions = await context.client.send(
      new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1 }),
    );
    const historical = (versions.Versions ?? []).length + (versions.DeleteMarkers ?? []).length;
    if (historical > 0) {
      throw new BucketNotEmptyError(
        `"${bucket}" still contains object versions or delete markers. Empty it with includeVersions, or delete it with ?force=true.`,
      );
    }
  }

  /** Empties the bucket in this request, or refuses with the size it found. */
  private async emptyInline(context: StorageContext, bucket: string): Promise<void> {
    const versioning = await this.facts.readVersioning(context.client, bucket);
    const outcome = await this.deleter.deletePrefix(
      context.client,
      bucket,
      '',
      versioning !== 'off',
      FORCE_DELETE_MAX_OBJECTS,
    );

    if (outcome.truncated) {
      // The operator asked for the bucket to be emptied and removed, so the emptying
      // is started rather than merely suggested — but the bucket is still there, and
      // saying otherwise with a 204 would be the lie this whole path avoids.
      const job = this.jobs.enqueue({
        type: 'empty-bucket',
        source: { serverId: context.row.id, bucket },
        params: { includeVersions: versioning !== 'off' },
      });

      throw new BucketNotEmptyError(
        `"${bucket}" holds more than ${FORCE_DELETE_MAX_OBJECTS} objects, which is more than one request can remove. Emptying it has been queued as job ${job.id}; delete the bucket again once that job has finished.`,
      );
    }
    if (outcome.errors.length > 0) {
      const [first] = outcome.errors;
      throw new BucketNotEmptyError(
        `"${bucket}" could not be emptied: ${outcome.errors.length} object(s) were refused (${first?.message ?? 'no detail'}).`,
      );
    }
  }

  /**
   * Noncurrent versions, bounded. `null` — the contract's "unknown" — for a bucket
   * with more versions than the budget: a number that stops counting part way
   * through is worse than no number, because the UI would present it as the total.
   */
  private async countNoncurrentVersions(
    context: StorageContext,
    bucket: string,
  ): Promise<number | null> {
    let count = 0;
    let pages = 0;
    let keyMarker: string | undefined = undefined;
    let versionMarker: string | undefined = undefined;

    do {
      if (pages >= VERSION_COUNT_PAGE_BUDGET) return null;
      // Annotated: the markers are read into the request and assigned from the
      // response, which TypeScript treats as a circular inference.
      const response: ListObjectVersionsCommandOutput = await context.client.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          MaxKeys: VERSION_PAGE_SIZE,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
      );
      pages += 1;

      count += (response.Versions ?? []).filter((version) => version.IsLatest !== true).length;

      if (response.IsTruncated === true) {
        keyMarker = response.NextKeyMarker;
        versionMarker = response.NextVersionIdMarker;
      } else {
        keyMarker = undefined;
        versionMarker = undefined;
      }
    } while (keyMarker !== undefined || versionMarker !== undefined);

    return count;
  }

  /**
   * A 404 for a bucket the server does not have, rather than an empty settings
   * page built from five "not configured" answers.
   */
  private async requireBucket(context: StorageContext, bucket: string): Promise<void> {
    try {
      await context.client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      const mapped = mapProviderError(error);
      if (mapped?.code === 'NOT_FOUND') {
        throw new NotFoundError(`No bucket named "${bucket}" on this server.`);
      }
      throw error;
    }
  }

  /** `serverId` in the query accepts a name, like every other `:id` in the API. */
  private filtersOf(query: ListBucketsQuery): {
    q?: string;
    serverId?: string;
    access?: ListBucketsQuery['access'];
    sort: ListBucketsQuery['sort'];
  } {
    const resolved =
      query.serverId === undefined ? undefined : this.servers.findByIdOrName(query.serverId);
    if (query.serverId !== undefined && resolved === null) {
      throw new NotFoundError(`No server named "${query.serverId}".`);
    }

    return {
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(resolved === undefined || resolved === null ? {} : { serverId: resolved.id }),
      ...(query.access === undefined ? {} : { access: query.access }),
      sort: query.sort,
    };
  }
}
