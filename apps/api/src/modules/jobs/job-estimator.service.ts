import { Injectable } from '@nestjs/common';
import type { EstimateJobResponse, JobFilters } from '@storage-io/contracts';
import type { StorageContext } from '../storage/storage-context.service';
import { JobSourceService } from './job-source.service';

/**
 * `POST /jobs/estimate`, and the same walk the engine uses to learn a job's
 * `progress.total`.
 *
 * It is **time-boxed, not object-boxed**: an operator asking "how much is this?"
 * is waiting on the answer, and a bucket with forty million objects must produce a
 * number in a couple of seconds rather than an honest count in four minutes. When
 * the budget runs out the answer says `partial: true` and the UI shows it as "at
 * least" — which is the only truthful way to report a listing that did not finish.
 *
 * A partial estimate is deliberately **not** stored as a job's total: a progress
 * bar against a number known to be too small reads as a job that overshoots 100%.
 */

/** What a request will wait for. */
export const ESTIMATE_BUDGET_MS = 3_000;
/** What the engine will wait for at the start of a run, before any work. */
export const TOTAL_BUDGET_MS = 8_000;

@Injectable()
export class JobEstimatorService {
  constructor(private readonly source: JobSourceService) {}

  async estimate(
    context: StorageContext,
    bucket: string,
    filters: JobFilters,
    includeVersions: boolean,
    budgetMs: number = ESTIMATE_BUDGET_MS,
  ): Promise<EstimateJobResponse> {
    const deadline = Date.now() + budgetMs;
    let objects = 0;
    let bytes = 0;
    let token: string | null = null;

    for (;;) {
      const page = await this.source.page({
        client: context.client,
        bucket,
        filters,
        includeVersions,
        startToken: token,
      });

      for (const candidate of page.items) {
        objects += 1;
        bytes += candidate.size;
      }

      token = page.nextToken;
      if (token === null) return { objects, bytes, partial: false };
      if (Date.now() >= deadline) return { objects, bytes, partial: true };
    }
  }

  /** The total to store on a job, or `null` when the listing did not finish. */
  async totalFor(
    context: StorageContext,
    bucket: string,
    filters: JobFilters,
    includeVersions: boolean,
  ): Promise<number | null> {
    const estimate = await this.estimate(
      context,
      bucket,
      filters,
      includeVersions,
      TOTAL_BUDGET_MS,
    );
    return estimate.partial ? null : estimate.objects;
  }
}
