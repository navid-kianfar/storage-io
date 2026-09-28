import { Controller, Sse } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { finalize, map, merge, type Observable } from 'rxjs';
import { interval } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { EventBusService } from './event-bus.service';

/** A comment frame keeps proxies from closing an idle stream. */
const KEEPALIVE_INTERVAL_MS = 25_000;

interface SseFrame extends MessageEvent {
  readonly type: string;
  readonly data: object;
}

/**
 * `GET /api/v1/events`. Authenticated like every other route — the global guard
 * covers it, so an unauthenticated client gets problem+json rather than a stream.
 */
@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly bus: EventBusService) {}

  @Sse()
  @ApiOperation({
    summary: 'Live event stream (SSE)',
    description:
      'Emits server.health, job.progress, job.status, notification and inventory.updated events. `data` is JSON matching the payload schema for that event name.',
  })
  stream(): Observable<SseFrame> {
    this.bus.trackSubscriber(1);

    const events = this.bus.stream.pipe(
      map((event): SseFrame => ({ type: event.event, data: event.data })),
    );
    const keepalive = interval(KEEPALIVE_INTERVAL_MS).pipe(
      map((): SseFrame => ({ type: 'ping', data: { at: new Date().toISOString() } })),
    );

    return merge(events, keepalive).pipe(finalize(() => this.bus.trackSubscriber(-1)));
  }
}
