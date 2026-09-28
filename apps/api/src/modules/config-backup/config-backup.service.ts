import { Injectable, Logger } from '@nestjs/common';
import {
  SERVER_OPTION_DEFAULTS,
  type ImportSettingsResponse,
  type ServerOptions,
} from '@storage-io/contracts';
import { CryptoService } from '../../crypto/crypto.service';
import { SettingsService } from '../../settings/settings.service';
import { ServerRepository } from '../../servers/server.repository';
import { ProviderRegistryService } from '../../providers/provider-registry.service';
import { ValidationError } from '../../common/errors/domain.exception';
import { APP_VERSION } from '../../version';
import type { ServerRow } from '../../db/schema';
import {
  ArchiveError,
  decryptArchive,
  encryptArchive,
  type ArchivedServer,
  type ConfigArchive,
} from './config-archive';

/**
 * Export and import of the whole configuration: every settings section and every
 * saved server connection, credentials included, in one passphrase-encrypted file.
 *
 * ## Import semantics, decided here so they are the same every time
 *
 * - **Settings are replaced section by section**, not merged. An operator restoring
 *   a backup wants the configuration in the file, not the file's values layered over
 *   whatever this install had drifted to.
 * - **Servers are matched by name.** A name that exists is updated in place, which
 *   keeps its id and therefore its buckets, quotas, metrics and job history; a name
 *   that does not is inserted. Nothing is ever deleted: an import must not remove a
 *   server the operator added after the backup was taken.
 * - **No connection test is run.** Importing fifty servers would otherwise take
 *   fifty round trips before the request answered, and an import onto a host that
 *   cannot yet reach them would report failures that are not the archive's fault.
 *   The imported rows start `unknown` and the health checker settles them within one
 *   interval.
 * - **`security.allowedNetworks` comes back with the rest.** It can lock the
 *   importing operator out, exactly as a PATCH of that field can — `/health` stays
 *   reachable and the way back is the documented one. Silently dropping it would
 *   make a restore incomplete in the one section where that is dangerous.
 */
@Injectable()
export class ConfigBackupService {
  private readonly log = new Logger(ConfigBackupService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly servers: ServerRepository,
    private readonly crypto: CryptoService,
    private readonly registry: ProviderRegistryService,
  ) {}

  /** The encrypted archive, ready to be written to the response. */
  async export(passphrase: string): Promise<Buffer> {
    const rows = this.servers.findAll();
    const archive: ConfigArchive = {
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      // `getInternal`, not `getPublic`: the secrets are the point of the backup.
      settings: this.settings.getInternal(),
      servers: rows.map((row) => this.toArchived(row)),
    };
    return encryptArchive(archive, passphrase);
  }

  async import(file: Buffer, passphrase: string): Promise<ImportSettingsResponse> {
    let archive: ConfigArchive;
    try {
      archive = await decryptArchive(file, passphrase);
    } catch (error) {
      if (error instanceof ArchiveError) throw new ValidationError(error.message);
      throw error;
    }

    const imported = this.restoreServers(archive.servers);
    this.settings.replaceAll(archive.settings);

    this.log.log(
      { servers: imported, exportedAt: archive.exportedAt, from: archive.appVersion },
      'Configuration archive imported',
    );
    return { servers: imported, settings: true };
  }

  /* ------------------------------ internals ------------------------- */

  /**
   * A row whose secret cannot be decrypted (`APP_SECRET` changed) is exported with
   * an empty secret rather than failing the whole backup: the endpoint, region and
   * options are still worth restoring, and the operator has to re-enter that key
   * either way.
   */
  private toArchived(row: ServerRow): ArchivedServer {
    return {
      name: row.name,
      provider: row.provider,
      endpoint: row.endpoint,
      region: row.region,
      accessKeyId: row.accessKeyId,
      secretAccessKey: this.decryptOrEmpty(row.secretEncrypted),
      adminToken:
        row.adminTokenEncrypted === null ? null : this.decryptOrEmpty(row.adminTokenEncrypted),
      options: {
        pathStyle: row.pathStyle,
        tlsVerify: row.tlsVerify,
        caPem: row.caPem,
        adminEndpoint: row.adminEndpoint,
        iamEndpoint: row.iamEndpoint,
        healthIntervalSec: row.healthIntervalSec,
      },
      maintenance: row.maintenance,
    };
  }

  private restoreServers(servers: readonly ArchivedServer[]): number {
    let count = 0;
    const now = new Date().toISOString();

    for (const archived of servers) {
      const options: ServerOptions = { ...SERVER_OPTION_DEFAULTS, ...archived.options };
      const credentials = {
        accessKeyId: archived.accessKeyId,
        secretEncrypted: this.crypto.encryptSecret(archived.secretAccessKey),
        adminTokenEncrypted:
          archived.adminToken === null ? null : this.crypto.encryptSecret(archived.adminToken),
      };

      const existing = this.servers.findByName(archived.name);
      if (existing === null) {
        this.servers.insert({
          id: this.crypto.newId(),
          name: archived.name,
          provider: archived.provider,
          endpoint: archived.endpoint,
          region: archived.region,
          ...credentials,
          pathStyle: options.pathStyle,
          tlsVerify: options.tlsVerify,
          caPem: options.caPem,
          adminEndpoint: options.adminEndpoint,
          iamEndpoint: options.iamEndpoint,
          healthIntervalSec: options.healthIntervalSec,
          maintenance: archived.maintenance,
          createdAt: now,
          updatedAt: now,
        });
        count += 1;
        continue;
      }

      this.servers.update(existing.id, {
        provider: archived.provider,
        endpoint: archived.endpoint,
        region: archived.region,
        ...credentials,
        pathStyle: options.pathStyle,
        tlsVerify: options.tlsVerify,
        caPem: options.caPem,
        adminEndpoint: options.adminEndpoint,
        iamEndpoint: options.iamEndpoint,
        healthIntervalSec: options.healthIntervalSec,
        maintenance: archived.maintenance,
        // The stored capabilities describe the old host's view; a check settles
        // them. Leaving them would show features the restored key may not have.
        status: 'unknown',
        statusDetail: null,
      });
      // The cached S3 client and admin agent belong to the previous credentials.
      this.registry.evict(existing.id);
      count += 1;
    }

    return count;
  }

  private decryptOrEmpty(envelope: string): string {
    try {
      return this.crypto.decryptSecret(envelope);
    } catch {
      this.log.warn('A stored server secret could not be decrypted; exported empty');
      return '';
    }
  }
}
