import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfigService } from '../../config/app-config.service';
import type { JobRow } from '../../db/schema';
import { JobsRepository } from './jobs.repository';
import { JobsService } from './jobs.service';
import { nextRunAfter } from './cron';

/**
 * Fires the schedules whose time has come.
 *
 * One interval that asks the database which schedules are due, rather than a timer
 * per schedule — the same choice the health checker makes, and for the same
 * reason: a timer per row has to be re-registered whenever the row changes, and
 * this way an edited cron takes effect on the next tick with no bookkeeping.
 *
 * ## The two kinds
 *
 * - **`cron`** produces a child run and stays `scheduled` with a fresh
 *   `nextRunAt`. The parent never runs itself, which is what makes
 *   `GET /jobs/:id/runs` a history rather than a mix of the schedule and its runs.
 * - **`at`** *is* the run: the row goes `scheduled → queued` and `nextRunAt` is
 *   cleared. There is only ever one, so a child would be an extra row saying
 *   nothing.
 *
 * ## Catching up
 *
 * A schedule whose time passed while storage-io was down fires **once** on the
 * next tick, not once per missed interval. An hourly copy that was missed
 * fourteen times overnight wants one run, not fourteen queued behind each other —
 * and `nextRunAt` is recomputed from *now*, so the series re-bases instead of
 * chasing the past.
 *
 * A schedule whose previous run is still going is skipped with a log line: two
 * runs of the same copy over the same bucket would fight over the same keys.
 */

const TICK_INTERVAL_MS = 10_000;

@Injectable()
export class JobSchedulerService {
  private readonly log = new Logger(JobSchedulerService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly repository: JobsRepository,
    private readonly jobs: JobsService,
  ) {}

  @Interval(TICK_INTERVAL_MS)
  tick(): void {
    if (!this.config.jobEngineEnabled) return;
    this.fireDue();
  }

  /** Separated from the tick so a test can fire the schedules deterministically. */
  fireDue(now: Date = new Date()): number {
    const due = this.repository.dueSchedules(now.toISOString());
    let fired = 0;

    for (const row of due) {
      try {
        if (this.fire(row, now)) fired += 1;
      } catch (error) {
        // One bad schedule must not stop the others, and must not stop the tick.
        this.log.error(
          { jobId: row.id, err: error instanceof Error ? error.message : String(error) },
          'Could not fire a scheduled job',
        );
      }
    }
    return fired;
  }

  private fire(row: JobRow, now: Date): boolean {
    const schedule = this.repository.toContract(row).schedule;

    if (schedule.kind === 'at') {
      this.repository.update(row.id, { status: 'queued', nextRunAt: null, waitingFor: null });
      this.log.log({ jobId: row.id }, 'One-off schedule is due; queued');
      return true;
    }

    if (schedule.kind !== 'cron') {
      // A `now` schedule sitting in `scheduled` is a row an older version wrote;
      // queueing it is the only sensible reading.
      this.repository.update(row.id, { status: 'queued', nextRunAt: null });
      return true;
    }

    if (!schedule.enabled) {
      // Disabled while a next run was still set. Clearing it is what disable means.
      this.repository.update(row.id, { nextRunAt: null });
      return false;
    }

    const nextRunAt = nextRunAfter(schedule.cron, schedule.timezone, now);
    if (nextRunAt === null) {
      this.repository.update(row.id, { nextRunAt: null });
      this.log.warn(
        { jobId: row.id, cron: schedule.cron, timezone: schedule.timezone },
        'A stored cron expression no longer parses; the schedule is disabled',
      );
      this.repository.appendLogs(row.id, [
        {
          at: now.toISOString(),
          level: 'error',
          message: 'This schedule’s cron expression could not be read, so it will not run again.',
          key: null,
        },
      ]);
      return false;
    }

    if (this.hasRunInFlight(row.id)) {
      this.repository.update(row.id, { nextRunAt });
      this.log.warn({ jobId: row.id }, 'Skipped a scheduled run: the previous one is still going');
      this.repository.appendLogs(row.id, [
        {
          at: now.toISOString(),
          level: 'warn',
          message: 'Skipped this run: the previous one had not finished.',
          key: null,
        },
      ]);
      return false;
    }

    const run = this.jobs.spawnRun(row);
    this.repository.update(row.id, { nextRunAt });
    this.log.log({ jobId: row.id, runId: run.id, nextRunAt }, 'Scheduled job fired');
    return true;
  }

  /** A child run of this schedule that has not reached a terminal status. */
  private hasRunInFlight(parentId: string): boolean {
    const { rows } = this.repository.children(parentId, { page: 1, pageSize: 5 });
    return rows.some(
      (row) => row.status === 'queued' || row.status === 'running' || row.status === 'paused',
    );
  }
}
