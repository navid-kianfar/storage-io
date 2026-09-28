import { Injectable, Logger } from '@nestjs/common';
import type { Capability, Provider, UnavailableServer } from '@storage-io/contracts';
import {
  DomainException,
  NotFoundError,
  NotSupportedError,
} from '../../common/errors/domain.exception';
import type { ServerRow } from '../../db/schema';
import { ServerRepository } from '../../servers/server.repository';
import { ProviderRegistryService } from '../../providers/provider-registry.service';
import type { ServerConnection } from '../../providers/provider-driver';

/**
 * Turning a request into the server (or servers) it acts on.
 *
 * Every IAM endpoint is one of two shapes, and both are here so neither is
 * re-implemented four times:
 *
 * - `/servers/:sid/iam/...` — one server, by id or name, decrypted into a
 *   `ServerConnection`. `ServerRepository.toConnection` is the only place a secret
 *   is decrypted, so this service goes through it rather than around it.
 * - `/iam/...` — every server whose driver supports the resource. One server being
 *   down must not empty the list, so each is asked independently and a failure
 *   becomes an `unavailable` entry naming it.
 */

export interface IamTarget {
  readonly row: ServerRow;
  readonly connection: ServerConnection;
}

export interface Aggregated<T> {
  readonly items: readonly T[];
  readonly unavailable: readonly UnavailableServer[];
}

@Injectable()
export class IamTargetService {
  private readonly log = new Logger(IamTargetService.name);

  constructor(
    private readonly servers: ServerRepository,
    private readonly registry: ProviderRegistryService,
  ) {}

  /** One server by id or name. 404 when there is none. */
  target(idOrName: string): IamTarget {
    const row = this.servers.findByIdOrName(idOrName);
    if (row === null) throw new NotFoundError(`No server named "${idOrName}".`);
    return { row, connection: this.servers.toConnection(row) };
  }

  /**
   * One server, refusing up front what this provider can never do.
   *
   * A driver shared between providers cannot leave a method out per provider —
   * `aws-iam` serves AWS, Wasabi and SeaweedFS, and only the first two have groups.
   * So `not_supported` in the capability profile is the authority, and checking it
   * here saves a round trip that would come back as a 501 and gives one message that
   * names the provider.
   *
   * `not_configured` is deliberately *not* refused: it may only mean the last probe
   * could not reach the endpoint, and an operator who has just fixed that should not
   * have to wait for a health tick.
   */
  targetFor(idOrName: string, capability: Capability): IamTarget {
    const target = this.target(idOrName);
    if (target.row.capabilities[capability] === 'not_supported') {
      throw new NotSupportedError(
        `${target.row.provider} does not support ${capability} in storage-io.`,
      );
    }
    return target;
  }

  /**
   * Whether a key can be deactivated on this server. It is the same ability an
   * app-tracked expiry needs — disabling a key when its date passes — which is why
   * the profile records it as `accessKeyExpiry`. Ceph RGW and Garage can only
   * *remove* a key, and removing one on an operator's behalf is not a decision
   * storage-io makes silently.
   */
  canDeactivateKeys(target: IamTarget): boolean {
    return target.row.capabilities['accessKeyExpiry'] !== 'not_supported';
  }

  get providers(): ProviderRegistryService {
    return this.registry;
  }

  /**
   * The servers an aggregated list should ask.
   *
   * A capability that is `not_supported` or `not_configured` is left out rather
   * than asked and reported broken: the server's own capability map already tells
   * the UI that, and putting it in `unavailable` would fill the list with servers
   * that are working exactly as intended. What lands in `unavailable` is a server
   * that *should* have answered.
   */
  candidates(capability: Capability, serverId?: string): readonly ServerRow[] {
    const rows =
      serverId === undefined ? this.servers.findAll() : [this.servers.findByIdOrName(serverId)];

    return rows.filter(
      (row): row is ServerRow => row !== null && row.capabilities[capability] === 'supported',
    );
  }

  /**
   * Runs `ask` against every candidate at once and collects what came back.
   *
   * `Promise.allSettled`, not `all`: one offline server must not reject the whole
   * list. The message an `unavailable` entry carries is the domain error's detail
   * where there is one, and a fixed sentence otherwise — a provider's own error
   * body never crosses the boundary.
   */
  async aggregate<T>(
    capability: Capability,
    serverId: string | undefined,
    ask: (target: IamTarget) => Promise<readonly T[]>,
  ): Promise<Aggregated<T>> {
    const rows = this.candidates(capability, serverId);

    const settled = await Promise.allSettled(
      rows.map(async (row) => ask({ row, connection: this.servers.toConnection(row) })),
    );

    const items: T[] = [];
    const unavailable: UnavailableServer[] = [];

    settled.forEach((result, index) => {
      const row = rows[index];
      if (row === undefined) return;
      if (result.status === 'fulfilled') {
        items.push(...result.value);
        return;
      }
      this.log.warn(
        { server: row.name, capability, err: describe(result.reason) },
        'A server could not be included in an aggregated IAM list',
      );
      unavailable.push({ serverId: row.id, message: describe(result.reason) });
    });

    return { items, unavailable };
  }

  /** The three fields every aggregated IAM item carries about its server. */
  stamp(row: ServerRow): {
    readonly serverId: string;
    readonly serverName: string;
    readonly provider: Provider;
  } {
    return { serverId: row.id, serverName: row.name, provider: row.provider as Provider };
  }
}

/** A message safe to show a client: no provider body, no stack, no path. */
function describe(reason: unknown): string {
  if (reason instanceof DomainException) return reason.message;
  return 'The server did not answer.';
}
