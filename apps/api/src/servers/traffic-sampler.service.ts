import { Injectable, Logger } from '@nestjs/common';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import type { ServerConnection, TrafficCounters } from '../providers/provider-driver';
import { ServerRepository } from './server.repository';
import type { MetricsTrafficRow, ServerRow } from '../db/schema';

/**
 * Turns a provider's cumulative traffic counters into the per-second series the
 * server overview's "Traffic" chart draws.
 *
 * It rides the health check rather than running its own timer: the check already
 * decides which servers are due, already has a decrypted connection in hand, and
 * already skips the ones in maintenance. A second timer would sample an offline
 * server, and would need its own copy of all three rules.
 *
 * ## Why the previous sample comes from the database
 *
 * A rate needs two readings. Holding the previous one in memory would lose the
 * whole series on every restart and would make the numbers depend on how long the
 * process had been up. Reading the last row instead costs one indexed lookup and
 * makes a restart cost exactly one sample.
 *
 * ## What is deliberately not recorded
 *
 * - A **counter that went backwards** means the storage server restarted, so the
 *   delta is meaningless: the counters are stored and the rates left null, which
 *   re-bases the series without inventing a spike.
 * - A **sample less than a second after the last one** would divide by a rounding
 *   error. It is skipped entirely.
 * - A **failed metrics call** is logged at debug and nothing is written. The
 *   endpoint being unreachable is not a health problem — the server answered
 *   ListBuckets — and an operator who has not enabled Prometheus auth should not
 *   get an error per interval.
 */

/** Below this the division is noise rather than a rate. */
const MIN_INTERVAL_MS = 1_000;

@Injectable()
export class TrafficSamplerService {
  private readonly log = new Logger(TrafficSamplerService.name);

  constructor(
    private readonly repository: ServerRepository,
    private readonly registry: ProviderRegistryService,
  ) {}

  /**
   * Samples one server, if its provider has a metrics endpoint. Never throws:
   * the caller is the health checker, and a metrics failure must not change what
   * it concluded about the server's health.
   */
  async sample(row: ServerRow, connection: ServerConnection): Promise<void> {
    const driver = this.registry.trafficIfAny(connection);
    if (driver === null) return;

    try {
      const counters = await driver.sample(connection);
      if (counters === null) return;
      this.store(row.id, counters);
    } catch (error) {
      this.log.debug(
        { server: row.name, err: error instanceof Error ? error.message : String(error) },
        'Traffic sample failed',
      );
    }
  }

  private store(serverId: string, counters: TrafficCounters): void {
    const previous = this.repository.lastTrafficSample(serverId);
    const rates = ratesBetween(previous, counters, Date.now());
    if (rates === SKIP_SAMPLE) return;

    this.repository.recordTraffic(serverId, { ...counters, ...rates });
  }
}

/* ------------------------------ helpers --------------------------- */

/** Distinguishes "no rate yet" from "do not record this sample at all". */
export const SKIP_SAMPLE = Symbol('SKIP_SAMPLE');

export interface TrafficRates {
  readonly requestsPerSec: number | null;
  readonly errorsPerSec: number | null;
  readonly rxBytesPerSec: number | null;
  readonly txBytesPerSec: number | null;
}

const NO_RATES: TrafficRates = {
  requestsPerSec: null,
  errorsPerSec: null,
  rxBytesPerSec: null,
  txBytesPerSec: null,
};

/**
 * The per-second rates between two readings, exported for the unit test because
 * this is where the counter-reset and short-interval rules actually live.
 */
export function ratesBetween(
  previous: MetricsTrafficRow | null,
  current: TrafficCounters,
  nowMs: number,
): TrafficRates | typeof SKIP_SAMPLE {
  if (previous === null) return NO_RATES;

  const elapsedMs = nowMs - Date.parse(previous.at);
  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_INTERVAL_MS) return SKIP_SAMPLE;

  const wentBackwards =
    current.requests < previous.requests ||
    current.errors < previous.errors ||
    current.rxBytes < previous.rxBytes ||
    current.txBytes < previous.txBytes;
  if (wentBackwards) return NO_RATES;

  const perSecond = (delta: number): number => (delta * 1000) / elapsedMs;
  return {
    requestsPerSec: perSecond(current.requests - previous.requests),
    errorsPerSec: perSecond(current.errors - previous.errors),
    rxBytesPerSec: perSecond(current.rxBytes - previous.rxBytes),
    txBytesPerSec: perSecond(current.txBytes - previous.txBytes),
  };
}
