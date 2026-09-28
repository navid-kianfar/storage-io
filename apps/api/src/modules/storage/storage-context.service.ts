import { Injectable } from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  emptyCapabilityMap,
  type Capability,
  type CapabilityMap,
  type CapabilityState,
  type Provider,
} from '@storage-io/contracts';
import { NotFoundError, NotSupportedError } from '../../common/errors/domain.exception';
import { ServerRepository } from '../../servers/server.repository';
import { ProviderRegistryService } from '../../providers/provider-registry.service';
import type { ProviderDriver, ServerConnection } from '../../providers/provider-driver';
import type { ServerRow } from '../../db/schema';

/**
 * One place that turns a `:sid` path segment into everything a storage operation
 * needs: the row, the decrypted connection, a pooled S3 client, the driver and
 * the capability map.
 *
 * Buckets, objects and quotas all start their work the same way, and repeating
 * these five lines per handler is how one of them ends up forgetting the
 * capability check or building a second S3 client per request.
 */
export interface StorageContext {
  readonly row: ServerRow;
  readonly connection: ServerConnection;
  readonly client: S3Client;
  readonly driver: ProviderDriver;
  readonly provider: Provider;
  readonly capabilities: CapabilityMap;
}

@Injectable()
export class StorageContextService {
  constructor(
    private readonly servers: ServerRepository,
    private readonly registry: ProviderRegistryService,
  ) {}

  /** `:sid` accepts the id or the unique name, exactly as `/servers/:id` does. */
  forServer(idOrName: string): StorageContext {
    const row = this.servers.findByIdOrName(idOrName);
    if (row === null) throw new NotFoundError(`No server named "${idOrName}".`);
    return this.fromRow(row);
  }

  fromRow(row: ServerRow): StorageContext {
    const connection = this.servers.toConnection(row);
    const driver = this.registry.driverFor(connection.provider);
    return {
      row,
      connection,
      client: driver.createS3Client(connection),
      driver,
      provider: connection.provider,
      capabilities: capabilitiesOf(row.capabilities),
    };
  }

  /** Every server row, for the sweeps that walk the whole installation. */
  allRows(): readonly ServerRow[] {
    return this.servers.findAll();
  }

  /**
   * Refuses only a permanent no. `not_configured` is let through on purpose: the
   * capability map is a cached probe result, and telling an operator a feature is
   * unavailable when the server would in fact accept the call is worse than
   * letting the provider answer for itself.
   */
  requireCapability(context: StorageContext, capability: Capability, what: string): void {
    if (context.capabilities[capability] === 'not_supported') {
      throw new NotSupportedError(`${context.provider} does not support ${what}.`);
    }
  }

  supports(context: StorageContext, capability: Capability): boolean {
    return context.capabilities[capability] !== 'not_supported';
  }
}

/* ------------------------------ helpers --------------------------- */

const VALID_STATES: readonly CapabilityState[] = ['supported', 'not_configured', 'not_supported'];

/**
 * A stored map written by an older version may be missing keys; an absent key
 * becomes `not_configured`, which lets the call through rather than blocking a
 * feature on incomplete bookkeeping.
 */
function capabilitiesOf(stored: Record<string, string>): CapabilityMap {
  const base = emptyCapabilityMap('not_configured');
  const result: Record<string, CapabilityState> = { ...base };
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in base)) continue;
    if (!VALID_STATES.includes(value as CapabilityState)) continue;
    result[key] = value as CapabilityState;
  }
  return result as CapabilityMap;
}
