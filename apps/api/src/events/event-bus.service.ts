import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { SseEvent, SseEventName, SseEventPayload } from '@storage-io/contracts';

/**
 * The in-process fan-out behind `GET /api/v1/events`. Any module can publish;
 * every connected client receives. It is deliberately not durable: SSE is a live
 * hint that tells the web app which query to invalidate, and the authoritative
 * answer is always the REST endpoint.
 *
 * `Subject`, not `BehaviorSubject`: a client connecting must not be handed a
 * stale event from before it arrived.
 */
@Injectable()
export class EventBusService implements OnApplicationShutdown {
  private readonly logger = new Logger(EventBusService.name);
  private readonly subject = new Subject<SseEvent>();
  private subscribers = 0;

  /** Typed per event name, so a payload cannot be published under the wrong one. */
  publish<TName extends SseEventName>(event: TName, data: SseEventPayload<TName>): void {
    this.subject.next({ event, data } as SseEvent);
  }

  get stream(): Observable<SseEvent> {
    return this.subject.asObservable();
  }

  get subscriberCount(): number {
    return this.subscribers;
  }

  /** The SSE controller reports connect/disconnect so `/health` can show it. */
  trackSubscriber(delta: 1 | -1): void {
    this.subscribers += delta;
  }

  onApplicationShutdown(): void {
    this.subject.complete();
    this.logger.log('Event bus closed');
  }
}
