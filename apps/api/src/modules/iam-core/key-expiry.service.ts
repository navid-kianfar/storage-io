import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ACCESS_KEY_EXPIRING_DAYS } from '@storage-io/contracts';
import { AppConfigService } from '../../config/app-config.service';
import type { KeyMetaRow } from '../../db/schema';
import { NotificationsService } from '../../notifications/notifications.service';
import { ServerRepository } from '../../servers/server.repository';
import { ProviderRegistryService } from '../../providers/provider-registry.service';
import { IamEntityRepository } from './iam-entity.repository';
import { KeyMetaRepository } from './key-meta.repository';

/**
 * What makes an app-tracked expiry and a rotation grace period real.
 *
 * MinIO enforces a service account's expiry itself. An IAM, RGW or Garage key does
 * not expire at all, so storage-io stores the date in `key_meta` and this sweep is
 * the thing that acts on it. Three duties, in order of urgency:
 *
 * 1. **Rotations whose grace period is over** — the replacement has been in the
 *    caller's hands for `graceSeconds`, so the old key is deactivated now.
 * 2. **Keys past their expiry** — deactivated and marked `expired`, with a
 *    notification, because a key that silently stops working is a support ticket.
 * 3. **Keys expiring within the window** — announced once, so the operator has
 *    time to rotate rather than finding out from an outage.
 *
 * Every step is wrapped: one unreachable server must not stop the sweep, and the
 * next tick retries. Five minutes is short enough that a zero-second rotation feels
 * immediate (the rotate endpoint disables that one itself) and long enough not to
 * poll a dozen servers constantly.
 */

const EXPIRING_WINDOW_MS = ACCESS_KEY_EXPIRING_DAYS * 86_400_000;

@Injectable()
export class KeyExpiryService {
  private readonly log = new Logger(KeyExpiryService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly keyMeta: KeyMetaRepository,
    private readonly servers: ServerRepository,
    private readonly registry: ProviderRegistryService,
    private readonly notifications: NotificationsService,
    private readonly entities: IamEntityRepository,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'key-expiry' })
  async sweep(): Promise<void> {
    if (!this.config.iamSchedulerEnabled) return;
    await this.run();
  }

  /** Separate from the cron hook so a test can run one sweep deterministically. */
  async run(now: Date = new Date()): Promise<void> {
    const nowIso = now.toISOString();
    await this.finishRotations(nowIso);
    await this.expireOverdue(nowIso);
    this.announceExpiring(nowIso, new Date(now.getTime() + EXPIRING_WINDOW_MS).toISOString());
  }

  private async finishRotations(nowIso: string): Promise<void> {
    const due = this.keyMeta.dueRotations(nowIso);
    for (const row of due) {
      const disabled = await this.disableAtProvider(row, 'rotation');
      // The rotation is over either way: leaving `disableAt` in the past would make
      // the sweep retry it forever. A provider that refused is logged and the key
      // is reported as it really is on the next list.
      this.keyMeta.upsert(row.serverId, row.accessKeyId, {
        status: disabled ? 'disabled' : row.status === 'expired' ? 'expired' : 'active',
        rotationReplacedBy: null,
        rotationDisableAt: null,
      });
    }
  }

  private async expireOverdue(nowIso: string): Promise<void> {
    const due = this.keyMeta.dueExpiries(nowIso);
    for (const row of due) {
      await this.disableAtProvider(row, 'expiry');
      this.keyMeta.upsert(row.serverId, row.accessKeyId, { status: 'expired' });

      const serverName = this.serverNameOf(row.serverId);
      const keyId = this.entities.idFor(row.serverId, 'key', row.accessKeyId);
      this.notifications.raise({
        level: 'warning',
        title: 'An access key expired',
        detail: `"${row.name ?? row.accessKeyId}" for ${row.userName} on ${serverName} has expired and no longer works.`,
        // Rotating it is what the operator came to do; the route takes the key's
        // opaque id, never its access key id. See docs/ROUTES.md.
        href: `/keys/${keyId}/rotate`,
        ruleKey: 'key.expiring',
      });
    }
  }

  private announceExpiring(nowIso: string, untilIso: string): void {
    const soon = this.keyMeta.expiringSoon(nowIso, untilIso);
    for (const row of soon) {
      const serverName = this.serverNameOf(row.serverId);
      const keyId = this.entities.idFor(row.serverId, 'key', row.accessKeyId);
      this.notifications.raise({
        level: 'info',
        title: 'An access key expires soon',
        detail: `"${row.name ?? row.accessKeyId}" for ${row.userName} on ${serverName} expires on ${row.expiresAt ?? 'an unknown date'}.`,
        href: `/keys/${keyId}/rotate`,
        ruleKey: 'key.expiring',
      });
      this.keyMeta.upsert(row.serverId, row.accessKeyId, {
        expiryNotifiedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Deactivates a key at its provider. Returns whether it worked, and never
   * throws: the sweep's job is to make progress on the keys it can.
   */
  private async disableAtProvider(row: KeyMetaRow, reason: string): Promise<boolean> {
    const server = this.servers.findByIdOrName(row.serverId);
    if (server === null) return false;

    try {
      const connection = this.servers.toConnection(server);
      const keys = this.registry.iamKeysFor(connection);
      if (keys.update === undefined) {
        // Ceph and Garage cannot deactivate a key, only remove it, and removing
        // one on a schedule is not a decision this sweep gets to make.
        this.log.warn(
          { server: server.name, reason },
          'This provider cannot deactivate a key; it is marked in storage-io only',
        );
        return false;
      }
      await keys.update(connection, row.accessKeyId, row.userName, { enabled: false });
      this.log.log({ server: server.name, reason }, 'Deactivated an access key');
      return true;
    } catch (error) {
      this.log.warn(
        {
          server: server.name,
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Could not deactivate an access key; the next sweep retries',
      );
      return false;
    }
  }

  private serverNameOf(serverId: string): string {
    return this.servers.findByIdOrName(serverId)?.name ?? 'an unknown server';
  }
}
