import { Injectable, Logger } from '@nestjs/common';
import type {
  RotateServerCredentialsRequest,
  RotateServerCredentialsResponse,
} from '@storage-io/contracts';
import {
  NotSupportedError,
  ProviderError,
  ValidationError,
} from '../../common/errors/domain.exception';
import { CryptoService } from '../../crypto/crypto.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { ProviderRegistryService } from '../../providers/provider-registry.service';
import { S3ProbeService } from '../../providers/s3/s3-probe.service';
import type { ServerConnection } from '../../providers/provider-driver';
import type { IamAccessKeyOperations } from '../../providers/iam/iam-driver';
import { ServerRepository } from '../../servers/server.repository';
import { ServersService } from '../../servers/servers.service';
import { IamTargetService, type IamTarget } from '../iam-core/iam-target.service';
import { IamEntityRepository } from '../iam-core/iam-entity.repository';
import { KeyMetaRepository } from '../iam-core/key-meta.repository';

/**
 * `POST /servers/:id/rotate-credentials` — replacing the credential storage-io
 * itself uses to reach a server.
 *
 * This is the one rotation where getting the order wrong locks the operator out of
 * their own storage server, so the order is fixed and every step is undone on
 * failure:
 *
 * 1. **Create** the replacement through the IAM driver (`auto`), or take the one the
 *    operator supplies (`manual`).
 * 2. **Verify** it with real calls — S3, plus the admin/IAM surface where the
 *    provider has one. A credential that lists buckets but cannot reach the admin
 *    API would silently cost this server its users, policies and quotas.
 * 3. **Swap** the stored secret only once the new one is proven.
 * 4. **Retire** the old key last, and never at the cost of the rotation: a key that
 *    cannot be retired leaves a notification, not an exception, because by then the
 *    new credential is already in use.
 *
 * A failure at step 2 or 3 deletes the key created at step 1, so a failed rotation
 * leaves nothing behind.
 *
 * **What `auto` means per provider**, and why:
 *
 * - **MinIO**: a new *service account* under the identity the current key belongs
 *   to. It inherits exactly that identity's rights — no new user, no policy to
 *   guess, no chance of ending up with less access than before. When the current key
 *   is itself a service account the old one is deleted; when it is the root or a
 *   plain user's own key it is **left alone**, because MinIO cannot disable root and
 *   changing a user's own secret would break every other consumer of it.
 * - **AWS / Wasabi / SeaweedFS** (`aws-iam`): `CreateAccessKey` for the IAM user
 *   that owns the current key. The old key is deactivated where the provider can
 *   (AWS, Wasabi) and deleted where it cannot (SeaweedFS answers 501 to
 *   `UpdateAccessKey`).
 * - **Ceph RGW**: a new S3 key for the RGW user that owns the current one; the old
 *   key is removed, which is the only thing RGW can do to a key.
 * - **Garage**: refused. A Garage key *is* an identity, so a new key is a different
 *   identity with none of the bucket permissions the old one had — "rotating" would
 *   quietly lose access rather than preserve it.
 * - **R2 and generic S3**: refused; there is no API to create a key with.
 */
@Injectable()
export class ServerCredentialsService {
  private readonly log = new Logger(ServerCredentialsService.name);

  constructor(
    private readonly targets: IamTargetService,
    private readonly servers: ServerRepository,
    private readonly serversService: ServersService,
    private readonly registry: ProviderRegistryService,
    private readonly probes: S3ProbeService,
    private readonly crypto: CryptoService,
    private readonly keyMeta: KeyMetaRepository,
    private readonly notifications: NotificationsService,
    private readonly entities: IamEntityRepository,
  ) {}

  async rotate(
    idOrName: string,
    request: RotateServerCredentialsRequest,
  ): Promise<RotateServerCredentialsResponse> {
    const target = this.targets.target(idOrName);

    const replacement =
      request.mode === 'manual'
        ? {
            accessKeyId: request.accessKeyId,
            secretAccessKey: request.secretAccessKey,
            createdHere: false,
          }
        : await this.createReplacement(target);

    try {
      await this.verify(target, replacement.accessKeyId, replacement.secretAccessKey);
    } catch (error) {
      await this.discard(target, replacement);
      throw error;
    }

    try {
      this.swap(target, replacement.accessKeyId, replacement.secretAccessKey);
    } catch (error) {
      await this.discard(target, replacement);
      throw error;
    }

    // Past this point the new credential is live, so nothing below may throw.
    if (request.mode === 'auto') await this.retireOldKey(target);

    const rotatedAt = new Date().toISOString();
    this.log.log(
      { server: target.row.name, mode: request.mode },
      'Rotated the stored credentials for a storage server',
    );

    return { server: this.serversService.findOne(target.row.id), rotatedAt };
  }

  /* ----------------------------- creating -------------------------- */

  private async createReplacement(
    target: IamTarget,
  ): Promise<{ accessKeyId: string; secretAccessKey: string; createdHere: true }> {
    const keys = this.keysFor(target);
    const owner = await this.ownerOfCurrentKey(target, keys);

    const created = await keys.create(target.connection, {
      userName: owner,
      name: `storage-io rotated ${new Date().toISOString().slice(0, 10)}`,
      description: `Replaces ${target.connection.accessKeyId}`,
      // The credential storage-io runs on must not expire behind the operator's
      // back, and it is not an operator-facing key, so it gets no session policy.
      expiresAt: null,
      policy: null,
    });

    return {
      accessKeyId: created.accessKeyId,
      secretAccessKey: created.secretAccessKey,
      createdHere: true,
    };
  }

  /**
   * Which identity the replacement belongs to. It must be the identity the current
   * key already has, or the rotation would hand storage-io fewer rights than it
   * started with.
   */
  private async ownerOfCurrentKey(
    target: IamTarget,
    keys: IamAccessKeyOperations,
  ): Promise<string> {
    const current = await keys.get(target.connection, target.connection.accessKeyId);
    if (current !== null && current.userName.length > 0) return current.userName;

    // MinIO: the stored key is the root or a plain user's own key, not a service
    // account. A service account whose parent is that identity inherits its rights,
    // which is exactly what is wanted.
    if (target.row.provider === 'minio') return target.connection.accessKeyId;

    throw new NotSupportedError(
      'storage-io cannot tell which user the stored key belongs to on this server, so it will not guess; rotate manually and supply the new key.',
    );
  }

  private keysFor(target: IamTarget): IamAccessKeyOperations {
    if (target.row.provider === 'garage') {
      // A Garage key *is* the identity; a new one starts with no bucket
      // permissions, so this would lose access rather than rotate it.
      throw new NotSupportedError(
        'A Garage key is its own identity, so a new one would not carry the current permissions; create a key and grant it the same buckets, then rotate manually.',
      );
    }
    // Raises NOT_SUPPORTED for a provider with no access-key surface at all.
    return this.registry.iamKeysFor(target.connection);
  }

  /* ----------------------------- verifying ------------------------- */

  /**
   * Proves the new credential before anything is stored. S3 for every provider, and
   * the admin/IAM surface as well where the server has one — losing admin access is
   * the failure mode that would not show up until an operator opened the users page.
   */
  private async verify(
    target: IamTarget,
    accessKeyId: string,
    secretAccessKey: string,
  ): Promise<void> {
    const candidate: ServerConnection = { ...target.connection, accessKeyId, secretAccessKey };
    const client = this.registry.transientClient(candidate);

    try {
      await this.probes.listBuckets(client);
    } catch (error) {
      throw new ValidationError(
        `The new credentials were refused by ${target.row.name}, so nothing was changed.`,
        [{ path: 'accessKeyId', message: describe(error) }],
      );
    } finally {
      client.destroy();
    }

    const driver = this.registry.driverFor(candidate.provider);
    if (driver.iam === undefined) return;

    try {
      await driver.iam.ping(candidate);
    } catch (error) {
      throw new ValidationError(
        `The new credentials reach ${target.row.name} over S3 but not its admin API, which would lose users, policies and quotas — nothing was changed.`,
        [{ path: 'accessKeyId', message: describe(error) }],
      );
    }
  }

  /* ------------------------------ swapping ------------------------- */

  private swap(target: IamTarget, accessKeyId: string, secretAccessKey: string): void {
    const updated = this.servers.update(target.row.id, {
      accessKeyId,
      secretEncrypted: this.crypto.encryptSecret(secretAccessKey),
    });
    if (updated === null) {
      throw new ProviderError('The server row disappeared while its credentials were rotating.');
    }

    // The cached S3 client, admin agent and IAM client all hold the old secret;
    // dropping them here is what makes the new one take effect.
    this.registry.evict(target.row.id);
  }

  /* ------------------------------ retiring ------------------------- */

  /**
   * Retires the key that was replaced, using the connection as it was *before* the
   * swap — the new credential is live by now, but the old key's owner is recorded on
   * the old one.
   *
   * It never throws. A rotation that succeeded must not be reported as a failure
   * because the previous key could not be cleaned up, so the operator gets a
   * notification and the key stays visible in the keys list.
   */
  private async retireOldKey(target: IamTarget): Promise<void> {
    const oldAccessKeyId = target.connection.accessKeyId;
    // The old credential is what still has the rights to remove itself.
    const asOld = target.connection;

    try {
      const keys = this.registry.iamKeysFor(asOld);
      const old = await keys.get(asOld, oldAccessKeyId);

      if (old === null) {
        // MinIO's root key and a plain user's own key are not access keys the admin
        // API can retire. Leaving them is the safe answer, and the operator is told.
        this.warnKeyKept(target, oldAccessKeyId, 'it is not a key this provider can retire');
        return;
      }

      if (keys.update !== undefined) {
        await keys.update(asOld, oldAccessKeyId, old.userName, { enabled: false });
        this.keyMeta.upsert(target.row.id, oldAccessKeyId, {
          userName: old.userName,
          status: 'disabled',
        });
        this.log.log(
          { server: target.row.name },
          'Disabled the previous credential after rotating',
        );
        return;
      }

      // Ceph and SeaweedFS can only remove a key. The replacement is already proven
      // and in use, so removing the old one is the rotation finishing, not a risk.
      await keys.delete(asOld, oldAccessKeyId, old.userName);
      this.keyMeta.delete(target.row.id, oldAccessKeyId);
      this.log.log({ server: target.row.name }, 'Deleted the previous credential after rotating');
    } catch (error) {
      this.warnKeyKept(target, oldAccessKeyId, describe(error));
    }
  }

  private warnKeyKept(target: IamTarget, accessKeyId: string, reason: string): void {
    this.log.warn(
      { server: target.row.name, reason },
      'Rotated the credentials but could not retire the previous key',
    );
    // The link points at the key that was left behind, by its opaque id — the
    // operator's next action is on that one key, not on the whole list.
    const keyId = this.entities.idFor(target.row.id, 'key', accessKeyId);
    this.notifications.raise({
      level: 'warning',
      title: 'A rotated credential was left active',
      detail: `${target.row.name} now uses a new key, but the previous one (${mask(accessKeyId)}) is still active because ${reason} Remove it yourself when nothing else uses it.`,
      href: `/keys/${keyId}/edit`,
      ruleKey: 'key.expiring',
    });
  }

  /** Removes a key this rotation created, so a failed attempt leaves no debris. */
  private async discard(
    target: IamTarget,
    replacement: { accessKeyId: string; createdHere: boolean },
  ): Promise<void> {
    if (!replacement.createdHere) return;

    try {
      const keys = this.registry.iamKeysFor(target.connection);
      const created = await keys.get(target.connection, replacement.accessKeyId);
      const owner = created?.userName ?? target.connection.accessKeyId;
      await keys.delete(target.connection, replacement.accessKeyId, owner);
      this.keyMeta.delete(target.row.id, replacement.accessKeyId);
    } catch (error) {
      // The rotation is already failing; this is a second-order cleanup, and the key
      // it leaves behind is visible on the keys screen.
      this.log.warn(
        { server: target.row.name, err: describe(error) },
        'Could not remove the key created for a rotation that failed',
      );
    }
  }
}

/* ------------------------------ helpers --------------------------- */

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Enough of a key id to recognise, not enough to reuse. */
const mask = (accessKeyId: string): string =>
  accessKeyId.length <= 4 ? accessKeyId : `••••${accessKeyId.slice(-4)}`;
