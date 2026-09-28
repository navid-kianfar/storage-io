import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityIcon, dayBounds, dayKey, rangeFrom } from './eventStyles';

/**
 * The filter's date maths decides which events an operator is shown, so "last 24
 * hours" has to mean exactly that, and a custom range has to include both end days
 * in full — a range that stops at midnight on the last day silently hides it.
 */

const NOW = new Date('2026-09-28T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rangeFrom', () => {
  it('counts back from now for each preset', () => {
    expect(rangeFrom('1h')).toBe('2026-09-28T11:00:00.000Z');
    expect(rangeFrom('24h')).toBe('2026-09-27T12:00:00.000Z');
    expect(rangeFrom('7d')).toBe('2026-09-21T12:00:00.000Z');
    expect(rangeFrom('30d')).toBe('2026-08-29T12:00:00.000Z');
  });

  it('has no preset bound for a custom range', () => {
    expect(rangeFrom('custom')).toBeNull();
  });
});

describe('dayBounds', () => {
  it('covers both end days in full', () => {
    const { from, to } = dayBounds(new Date(2026, 8, 20, 15, 30), new Date(2026, 8, 22, 9, 0));
    // Local midnight to local end-of-day, whatever the runner's zone.
    expect(new Date(from).getHours()).toBe(0);
    expect(new Date(from).getMinutes()).toBe(0);
    expect(new Date(to).getHours()).toBe(23);
    expect(new Date(to).getMinutes()).toBe(59);
    expect(new Date(from).getDate()).toBe(20);
    expect(new Date(to).getDate()).toBe(22);
  });

  it('handles a single-day range', () => {
    const day = new Date(2026, 8, 20, 15, 30);
    const { from, to } = dayBounds(day, day);
    expect(Date.parse(to) - Date.parse(from)).toBeGreaterThan(86_399_000);
  });
});

describe('dayKey', () => {
  it('groups by calendar day', () => {
    expect(dayKey('2026-09-28T23:59:59.000Z')).toBe('2026-09-28');
    expect(dayKey('2026-09-29T00:00:01.000Z')).toBe('2026-09-29');
  });
});

describe('activityIcon', () => {
  it('prefers the action over the category', () => {
    expect(activityIcon('object.upload', 'objects')).not.toBe(
      activityIcon('object.delete', 'objects'),
    );
  });

  it('falls back to the category for an action it has never seen', () => {
    expect(activityIcon('something.brand-new', 'servers')).toBe(
      activityIcon('another.unknown', 'servers'),
    );
  });
});
