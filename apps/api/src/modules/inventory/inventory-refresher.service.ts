import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfigService } from '../../config/app-config.service';
import { ServerRepository } from '../../servers/server.repository';
import { InventoryService, INVENTORY_TTL_MS } from './inventory.service';

/** How often the refresher wakes to ask which servers are due. */
const TICK_INTERVAL_MS = 30_000;

/**
 * Drives `InventoryService.refreshServer` in the background.
 *
 * One interval that asks which servers are due, like the health checker and for
 * the same reason: a timer per server has to be re-registered whenever a server
 * is added or removed, and this way the bookkeeping is a timestamp per id.
 *
 * Passes are sequential. A pass spends up to `SCAN_PAGE_BUDGET` listing pages on
 * a server without a usage API, and running several of those at once would turn a
 * background sweep into the thing making every request slow.
 */
@Injectable()
export class InventoryRefresherService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(InventoryRefresherService.name);
  private running = false;
  private stopped = false;

  constructor(
    private readonly inventory: InventoryService,
    private readonly servers: ServerRepository,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.inventoryRefresherEnabled) {
      this.logger.log('Inventory refresher disabled by INVENTORY_REFRESHER_ENABLED');
      return;
    }
    this.logger.log(
      `Inventory refresher running every ${TICK_INTERVAL_MS} ms, per-server TTL ${INVENTORY_TTL_MS} ms`,
    );
  }

  onApplicationShutdown(): void {
    this.stopped = true;
  }

  @Interval(TICK_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.stopped || !this.config.inventoryRefresherEnabled) return;
    // A pass can outlast the interval on a slow server; overlapping passes would
    // scan the same buckets twice and double the load they were budgeted for.
    if (this.running) return;

    this.running = true;
    try {
      await this.sweep();
    } finally {
      this.running = false;
    }
  }

  /** `POST`-triggered refresh of one server, awaited by the caller. */
  async refreshNow(serverId: string): Promise<number | null> {
    const row = this.servers.findByIdOrName(serverId);
    if (row === null) return null;
    return this.inventory.refreshServer(row);
  }

  private async sweep(): Promise<void> {
    const due = this.servers.findAll().filter((row) => this.inventory.isDue(row));
    if (due.length === 0) return;

    for (const row of due) {
      if (this.stopped) return;
      await this.inventory.refreshServer(row);
    }
  }
}
