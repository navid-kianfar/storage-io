import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { ActivityEvent } from '@storage-io/contracts';
import { EventBusService } from '../events/event-bus.service';

/**
 * Publishes `activity.created` on the SSE stream, throttled.
 *
 * Every mutating request writes an audit row, and some things write a burst of
 * them: a bulk action over five hundred users, a job logging a line per page, an
 * import touching every server. Pushing one frame per row would make the stream
 * the slowest part of those operations and would tell the web app to refetch the
 * activity list five hundred times.
 *
 * So the first row goes out immediately — the common case is one row and it
 * should feel instant — and anything recorded inside the next
 * `ACTIVITY_EVENT_WINDOW_MS` is folded into a single trailing frame carrying the
 * **newest** row and how many were folded in. A client that only invalidates a
 * query needs no more than that; a client that counts can see it is behind.
 *
 * Leading edge plus one trailing frame, rather than a plain rate limit, is what
 * makes the last row of a burst always arrive: dropping it would leave the list
 * stale until something else happened.
 */
export const ACTIVITY_EVENT_WINDOW_MS = 1_000;

@Injectable()
export class ActivityEventPublisher implements OnApplicationShutdown {
  private windowEndsAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private pending: ActivityEvent | null = null;
  private suppressed = 0;

  constructor(private readonly bus: EventBusService) {}

  publish(event: ActivityEvent, now: number = Date.now()): void {
    if (now >= this.windowEndsAt) {
      this.windowEndsAt = now + ACTIVITY_EVENT_WINDOW_MS;
      this.bus.publish('activity.created', { event, suppressed: 0 });
      return;
    }

    // Inside the window: keep the newest row and remember that the earlier ones
    // are only represented by the count.
    if (this.pending !== null) this.suppressed += 1;
    this.pending = event;
    this.scheduleFlush(this.windowEndsAt - now);
  }

  onApplicationShutdown(): void {
    this.clearTimer();
    this.pending = null;
    this.suppressed = 0;
  }

  private scheduleFlush(delayMs: number): void {
    if (this.timer !== null) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delayMs);
    // The stream is a hint, never a reason to keep the process alive: a pending
    // frame must not hold the event loop open at shutdown or in a test.
    this.timer.unref();
  }

  private flush(): void {
    const event = this.pending;
    if (event === null) return;

    const suppressed = this.suppressed;
    this.pending = null;
    this.suppressed = 0;
    this.windowEndsAt = Date.now() + ACTIVITY_EVENT_WINDOW_MS;
    this.bus.publish('activity.created', { event, suppressed });
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
