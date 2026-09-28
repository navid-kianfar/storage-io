import { describe, expect, it, vi } from 'vitest';
import type { ActivityCreatedEventPayload } from '@storage-io/contracts';
import {
  ACTIVITY_EVENT_WINDOW_MS,
  ActivityEventPublisher,
} from '../../src/activity/activity-event.publisher';
import type { EventBusService } from '../../src/events/event-bus.service';

/**
 * The throttle in front of `activity.created`.
 *
 * What a client can observe is the point: the first row arrives at once, a burst
 * arrives as one trailing frame naming the newest row, and the count of what was
 * folded in is never lost. The timer is faked rather than waited on — a test that
 * sleeps for a second per case is a test people stop running.
 */

const published: { event: string; data: ActivityCreatedEventPayload }[] = [];

const busStub = {
  publish: (event: string, data: ActivityCreatedEventPayload): void => {
    published.push({ event, data });
  },
} as unknown as EventBusService;

const activityRow = (id: string): Parameters<ActivityEventPublisher['publish']>[0] => ({
  id,
  at: '2026-06-01T12:00:00.000Z',
  category: 'buckets',
  action: 'bucket.create',
  title: 'Created a bucket',
  actor: { type: 'admin', name: 'admin' },
  target: null,
  serverId: null,
  serverName: null,
  ip: null,
  result: 'success',
  requestId: null,
  details: {},
});

const freshPublisher = (): ActivityEventPublisher => {
  published.length = 0;
  return new ActivityEventPublisher(busStub);
};

describe('ActivityEventPublisher', () => {
  it('sends the first row immediately, with nothing suppressed', () => {
    const publisher = freshPublisher();

    publisher.publish(activityRow('one'), 1_000);

    expect(published).toHaveLength(1);
    expect(published[0]?.event).toBe('activity.created');
    expect(published[0]?.data.event.id).toBe('one');
    expect(published[0]?.data.suppressed).toBe(0);
  });

  it('folds a burst into one trailing frame naming the newest row', () => {
    vi.useFakeTimers();
    try {
      const publisher = freshPublisher();

      publisher.publish(activityRow('one'), 1_000);
      publisher.publish(activityRow('two'), 1_010);
      publisher.publish(activityRow('three'), 1_020);
      publisher.publish(activityRow('four'), 1_030);

      // Still just the leading frame while the window is open.
      expect(published).toHaveLength(1);

      vi.advanceTimersByTime(ACTIVITY_EVENT_WINDOW_MS);

      expect(published).toHaveLength(2);
      // The newest row, because a client refetches the list from it — and the two
      // it stands in for are counted, not dropped silently.
      expect(published[1]?.data.event.id).toBe('four');
      expect(published[1]?.data.suppressed).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the next row immediately once the window has passed', () => {
    const publisher = freshPublisher();

    publisher.publish(activityRow('one'), 1_000);
    publisher.publish(activityRow('later'), 1_000 + ACTIVITY_EVENT_WINDOW_MS);

    expect(published).toHaveLength(2);
    expect(published[1]?.data.event.id).toBe('later');
    expect(published[1]?.data.suppressed).toBe(0);
  });

  it('drops a pending frame at shutdown rather than firing after the bus closes', () => {
    vi.useFakeTimers();
    try {
      const publisher = freshPublisher();

      publisher.publish(activityRow('one'), 1_000);
      publisher.publish(activityRow('two'), 1_010);
      publisher.onApplicationShutdown();

      vi.advanceTimersByTime(ACTIVITY_EVENT_WINDOW_MS * 2);

      expect(published).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
