import { Injectable, Logger } from '@nestjs/common';
import {
  DeleteBucketCorsCommand,
  DeleteBucketLifecycleCommand,
  DeleteBucketPolicyCommand,
  DeleteBucketReplicationCommand,
  DeleteBucketTaggingCommand,
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketReplicationCommand,
  GetObjectLockConfigurationCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketReplicationCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  PutObjectLockConfigurationCommand,
  type ObjectLockRule,
} from '@aws-sdk/client-s3';
import {
  type BucketAccessResponse,
  type BucketAccessSettable,
  type BucketCorsBody,
  type BucketLifecycleBody,
  type BucketNotificationsBody,
  type BucketObjectLockBody,
  type BucketObjectLockResponse,
  type BucketPolicyBody,
  type BucketQuotaBody,
  type BucketQuotaResponse,
  type BucketReplicationBody,
  type BucketReplicationResponse,
  type BucketTagsBody,
  type BucketVersioning,
  type BucketVersioningBody,
  type JsonObject,
  type NotificationTargetStatus,
} from '@storage-io/contracts';
import { NotSupportedError } from '../../common/errors/domain.exception';
import { MinioAdminClient } from '../../providers/minio/minio-admin.client';
import { ProviderRegistryService } from '../../providers/provider-registry.service';
import { BucketFactsService } from '../inventory/bucket-facts.service';
import { InventoryService } from '../inventory/inventory.service';
import { QuotaRepository } from '../quotas/quota.repository';
import { StorageContextService, type StorageContext } from '../storage/storage-context.service';
import { accessFromPolicy, policyForAccess } from './policy-presets';
import { fromS3Cors, toS3Cors } from './mappers/cors.mapper';
import { fromS3Lifecycle, toS3Lifecycle } from './mappers/lifecycle.mapper';
import { fromS3Notifications, toS3Notifications } from './mappers/notifications.mapper';
import { fromS3Replication, toS3Replication } from './mappers/replication.mapper';
import { minioTargetStates } from './minio-notification-status';

/**
 * Every per-bucket setting: access, policy, versioning, object lock, lifecycle,
 * CORS, tags, replication, event notifications and quota.
 *
 * Two habits run through it:
 *
 * - **An empty collection is a delete, not an empty PUT.** `{ rules: [] }` for
 *   lifecycle or CORS means "no rules", and S3 rejects a configuration with an
 *   empty rule list; the delete verb is what actually expresses it.
 * - **Anything written here is also written to the inventory cache**, so the list
 *   the operator returns to reflects the change immediately instead of after the
 *   next refresher pass.
 */
@Injectable()
export class BucketSettingsService {
  private readonly logger = new Logger(BucketSettingsService.name);

  constructor(
    private readonly storage: StorageContextService,
    private readonly facts: BucketFactsService,
    private readonly inventory: InventoryService,
    private readonly registry: ProviderRegistryService,
    private readonly quotas: QuotaRepository,
    private readonly minioAdmin: MinioAdminClient,
  ) {}

  /* ------------------------------- access -------------------------- */

  async getAccess(sid: string, bucket: string): Promise<BucketAccessResponse> {
    const context = this.storage.forServer(sid);
    const policy = await this.facts.readPolicy(context.client, bucket);
    return { access: accessFromPolicy(policy, bucket), policy };
  }

  async setAccess(
    sid: string,
    bucket: string,
    access: BucketAccessSettable,
  ): Promise<BucketAccessResponse> {
    const context = this.storage.forServer(sid);
    this.storage.requireCapability(context, 'bucketPolicy', 'bucket policies');

    const policy = policyForAccess(access, bucket);
    await this.writePolicy(context, bucket, policy);
    this.inventory.patch(context.row.id, bucket, { access });

    return { access, policy };
  }

  async getPolicy(sid: string, bucket: string): Promise<BucketPolicyBody> {
    const context = this.storage.forServer(sid);
    return { policy: await this.facts.readPolicy(context.client, bucket) };
  }

  /**
   * A hand-written policy. The access level is re-derived from what was stored
   * rather than assumed: an operator who writes the public-read policy by hand
   * should see the bucket listed as public.
   */
  async setPolicy(
    sid: string,
    bucket: string,
    policy: JsonObject | null,
  ): Promise<BucketPolicyBody> {
    const context = this.storage.forServer(sid);
    this.storage.requireCapability(context, 'bucketPolicy', 'bucket policies');

    await this.writePolicy(context, bucket, policy);
    this.inventory.patch(context.row.id, bucket, { access: accessFromPolicy(policy, bucket) });

    return { policy };
  }

  /* ----------------------------- versioning ------------------------ */

  async getVersioning(sid: string, bucket: string): Promise<{ status: BucketVersioning }> {
    const context = this.storage.forServer(sid);
    return { status: await this.facts.readVersioning(context.client, bucket) };
  }

  async setVersioning(
    sid: string,
    bucket: string,
    body: BucketVersioningBody,
  ): Promise<{ status: BucketVersioning }> {
    const context = this.storage.forServer(sid);
    this.storage.requireCapability(context, 'versioning', 'bucket versioning');

    await context.client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: body.status === 'enabled' ? 'Enabled' : 'Suspended' },
      }),
    );
    this.inventory.patch(context.row.id, bucket, { versioning: body.status });

    return { status: body.status };
  }

  /* ----------------------------- object lock ----------------------- */

  async getObjectLock(sid: string, bucket: string): Promise<BucketObjectLockResponse> {
    const context = this.storage.forServer(sid);
    const rule = await this.readObjectLockRule(context, bucket);
    return {
      enabled: rule.enabled,
      mode: rule.mode,
      days: rule.days,
      years: rule.years,
    };
  }

  /**
   * Object lock **cannot be turned on after the fact** — S3 only accepts it at
   * `CreateBucket`, and no provider in scope offers a way around that. What this
   * endpoint can change is the *default retention* of a bucket that already has
   * lock enabled, so a bucket without it gets `NOT_SUPPORTED` with a message that
   * says what to do instead.
   */
  async setObjectLock(
    sid: string,
    bucket: string,
    body: BucketObjectLockBody,
  ): Promise<BucketObjectLockResponse> {
    const context = this.storage.forServer(sid);
    this.storage.requireCapability(context, 'objectLock', 'object lock');

    const current = await this.readObjectLockRule(context, bucket);
    if (!current.enabled) {
      throw new NotSupportedError(
        'Object lock can only be enabled when the bucket is created. Create a new bucket with object lock and move the objects across.',
      );
    }

    const rule = toObjectLockRule(body);
    await context.client.send(
      new PutObjectLockConfigurationCommand({
        Bucket: bucket,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          ...(rule === null ? {} : { Rule: rule }),
        },
      }),
    );

    return { enabled: true, mode: body.mode, days: body.days, years: body.years };
  }

  /* ------------------------------ lifecycle ------------------------ */

  async getLifecycle(sid: string, bucket: string): Promise<BucketLifecycleBody> {
    const context = this.storage.forServer(sid);
    const rules = await this.optionalRead('lifecycle', bucket, async () => {
      const response = await context.client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
      );
      return fromS3Lifecycle(response.Rules ?? []);
    });
    return { rules: [...(rules ?? [])] };
  }

  async setLifecycle(
    sid: string,
    bucket: string,
    body: BucketLifecycleBody,
  ): Promise<BucketLifecycleBody> {
    const context = this.storage.forServer(sid);
    this.storage.requireCapability(context, 'lifecycle', 'lifecycle rules');

    if (body.rules.length === 0) {
      await context.client.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
      return { rules: [] };
    }

    await context.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: { Rules: [...toS3Lifecycle(body.rules)] },
      }),
    );
    return body;
  }

  /* --------------------------------- CORS -------------------------- */

  async getCors(sid: string, bucket: string): Promise<BucketCorsBody> {
    const context = this.storage.forServer(sid);
    const rules = await this.optionalRead('cors', bucket, async () => {
      const response = await context.client.send(new GetBucketCorsCommand({ Bucket: bucket }));
      return fromS3Cors(response.CORSRules ?? []);
    });
    return { rules: [...(rules ?? [])] };
  }

  async setCors(sid: string, bucket: string, body: BucketCorsBody): Promise<BucketCorsBody> {
    const context = this.storage.forServer(sid);
    this.storage.requireCapability(context, 'cors', 'per-bucket CORS rules');

    if (body.rules.length === 0) {
      await context.client.send(new DeleteBucketCorsCommand({ Bucket: bucket }));
      return { rules: [] };
    }

    await context.client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: { CORSRules: [...toS3Cors(body.rules)] },
      }),
    );
    return body;
  }

  /* --------------------------------- tags -------------------------- */

  async getTags(sid: string, bucket: string): Promise<BucketTagsBody> {
    const context = this.storage.forServer(sid);
    return { tags: { ...(await this.facts.readTags(context.client, bucket)) } };
  }

  async setTags(sid: string, bucket: string, body: BucketTagsBody): Promise<BucketTagsBody> {
    const context = this.storage.forServer(sid);
    this.storage.requireCapability(context, 'tagging', 'bucket tags');

    const entries = Object.entries(body.tags);
    if (entries.length === 0) {
      await context.client.send(new DeleteBucketTaggingCommand({ Bucket: bucket }));
    } else {
      await context.client.send(
        new PutBucketTaggingCommand({
          Bucket: bucket,
          Tagging: { TagSet: entries.map(([Key, Value]) => ({ Key, Value })) },
        }),
      );
    }

    this.inventory.patch(context.row.id, bucket, { tags: body.tags });
    return body;
  }

  /* ------------------------------ replication ---------------------- */

  async getReplication(sid: string, bucket: string): Promise<BucketReplicationResponse> {
    const context = this.storage.forServer(sid);
    const rules = await this.optionalRead('replication', bucket, async () => {
      const response = await context.client.send(
        new GetBucketReplicationCommand({ Bucket: bucket }),
      );
      return fromS3Replication(response.ReplicationConfiguration);
    });

    const list = [...(rules ?? [])];
    return { rules: list, status: replicationStatusOf(list) };
  }

  async setReplication(
    sid: string,
    bucket: string,
    body: BucketReplicationBody,
  ): Promise<BucketReplicationResponse> {
    const context = this.storage.forServer(sid);
    this.storage.requireCapability(context, 'replication', 'bucket replication');

    if (body.rules.length === 0) {
      await context.client.send(new DeleteBucketReplicationCommand({ Bucket: bucket }));
      return { rules: [], status: null };
    }

    await context.client.send(
      new PutBucketReplicationCommand({
        Bucket: bucket,
        ReplicationConfiguration: toS3Replication(body.rules),
      }),
    );
    return { rules: body.rules, status: replicationStatusOf(body.rules) };
  }

  /* ---------------------------- notifications ---------------------- */

  async getNotifications(sid: string, bucket: string): Promise<BucketNotificationsBody> {
    const context = this.storage.forServer(sid);
    const response = await context.client.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: bucket }),
    );
    return { targets: [...fromS3Notifications(response)] };
  }

  async setNotifications(
    sid: string,
    bucket: string,
    body: BucketNotificationsBody,
  ): Promise<BucketNotificationsBody> {
    const context = this.storage.forServer(sid);
    this.storage.requireCapability(context, 'notifications', 'bucket event notifications');

    await context.client.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: toS3Notifications(body.targets),
      }),
    );
    return body;
  }

  /**
   * Delivery state per target. Only MinIO reports it, through the admin API's
   * service list; everywhere else the honest answer is `unknown` rather than a
   * green dot that means "configured", which is not the same as "reachable".
   */
  async notificationStatus(
    sid: string,
    bucket: string,
  ): Promise<readonly NotificationTargetStatus[]> {
    const context = this.storage.forServer(sid);
    const { targets } = await this.getNotifications(sid, bucket);
    const states = await minioTargetStates(context, this.minioAdmin, this.logger);

    return targets.map((target) => {
      const state = states.get(target.arn);
      return {
        targetId: target.id,
        arn: target.arn,
        state: state?.state ?? 'unknown',
        detail: state?.detail ?? null,
      };
    });
  }

  /* -------------------------------- quota -------------------------- */

  getQuota(sid: string, bucket: string): BucketQuotaResponse {
    const context = this.storage.forServer(sid);
    const stored = this.quotas.find(context.row.id, bucket);
    const cached = this.inventory.cached(context.row.id, bucket);

    return {
      quota:
        stored === null
          ? null
          : {
              limitBytes: stored.limitBytes,
              mode: stored.mode,
              threshold: stored.threshold,
              native: stored.native,
            },
      usage: { sizeBytes: cached?.sizeBytes ?? 0, objects: cached?.objects ?? 0 },
    };
  }

  /**
   * Sets the quota natively where the driver can, and always records it locally.
   *
   * The local row is not a duplicate: `threshold` has no native equivalent on any
   * provider, and the quotas page has to list every limit without polling every
   * server. `native` says whether the provider is enforcing it as well — which is
   * the difference between a limit that rejects a write and one that only warns.
   */
  async setQuota(sid: string, bucket: string, body: BucketQuotaBody): Promise<BucketQuotaResponse> {
    const context = this.storage.forServer(sid);
    await this.applyQuota(context, bucket, body);
    return this.getQuota(sid, bucket);
  }

  /** Shared with bucket creation and the bulk action, which both set a quota. */
  async applyQuota(
    context: StorageContext,
    bucket: string,
    body: BucketQuotaBody,
  ): Promise<boolean> {
    const canBeNative =
      this.registry.hasNativeQuota(context.connection) &&
      this.storage.supports(context, 'bucketQuota');

    let native = false;
    if (canBeNative) {
      const driver = this.registry.quotaFor(context.connection);
      // MinIO's only quota type is hard; an alert-only quota is storage-io's own
      // idea, so it is deliberately not pushed to the provider.
      const nativeLimit = body.mode === 'hard' ? body.limitBytes : null;
      await driver.setBucketQuota(context.connection, bucket, nativeLimit);
      native = nativeLimit !== null;
    }

    if (body.limitBytes === null) {
      this.quotas.remove(context.row.id, bucket);
      return false;
    }

    this.quotas.set(context.row.id, bucket, {
      limitBytes: body.limitBytes,
      mode: body.mode,
      threshold: body.threshold,
      native,
    });
    return native;
  }

  /* ------------------------------ internals ------------------------ */

  private async writePolicy(
    context: StorageContext,
    bucket: string,
    policy: JsonObject | null,
  ): Promise<void> {
    if (policy === null) {
      await context.client.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
      return;
    }
    await context.client.send(
      new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }),
    );
  }

  private async readObjectLockRule(
    context: StorageContext,
    bucket: string,
  ): Promise<{
    enabled: boolean;
    mode: BucketObjectLockBody['mode'];
    days: number | null;
    years: number | null;
  }> {
    const configuration = await this.optionalRead('objectLock', bucket, async () => {
      const response = await context.client.send(
        new GetObjectLockConfigurationCommand({ Bucket: bucket }),
      );
      return response.ObjectLockConfiguration;
    });

    if (configuration === null || configuration === undefined) {
      return { enabled: false, mode: null, days: null, years: null };
    }

    const retention = configuration.Rule?.DefaultRetention;
    return {
      enabled: configuration.ObjectLockEnabled === 'Enabled',
      mode: retention?.Mode ?? null,
      days: retention?.Days ?? null,
      years: retention?.Years ?? null,
    };
  }

  /**
   * A configuration read whose failure means "not set". S3 signals an absent
   * lifecycle, CORS or replication configuration with an error, so the absence has
   * to be caught rather than returned; a real failure is visible in the log with
   * the bucket and what was being read.
   */
  private async optionalRead<T>(
    what: string,
    bucket: string,
    read: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      this.logger.debug(
        { bucket, what, err: error instanceof Error ? error.message : String(error) },
        'Bucket configuration is unset or unreadable; reporting it as empty',
      );
      return null;
    }
  }
}

/* ------------------------------ helpers --------------------------- */

/** `Days` and `Years` are mutually exclusive in an S3 default-retention rule. */
function toObjectLockRule(body: BucketObjectLockBody): ObjectLockRule | null {
  if (body.mode === null) return null;
  if (body.days !== null) return { DefaultRetention: { Mode: body.mode, Days: body.days } };
  if (body.years !== null) return { DefaultRetention: { Mode: body.mode, Years: body.years } };
  return null;
}

/**
 * The contract's single `status` for a rule set. S3 has no aggregate, so it is
 * derived: enabled when anything is replicating, disabled when rules exist but
 * none are on.
 */
function replicationStatusOf(rules: readonly { enabled: boolean }[]): string | null {
  if (rules.length === 0) return null;
  return rules.some((rule) => rule.enabled) ? 'Enabled' : 'Disabled';
}
