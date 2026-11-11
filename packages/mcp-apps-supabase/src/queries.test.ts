import { describe, expect, test } from 'vitest';
import { TIME_RANGES } from './constants.js';
import {
  bucketForRange,
  resolveWindow,
  routesQuery,
  timeseriesQuery,
} from './queries.js';

describe('resolveWindow', () => {
  const now = new Date('2026-01-01T12:34:56.789Z');

  test.each([
    ['10m', '2026-01-01T12:24:00.000Z'],
    ['30m', '2026-01-01T12:04:00.000Z'],
    ['1h', '2026-01-01T11:34:00.000Z'],
    ['3h', '2026-01-01T09:34:00.000Z'],
    ['24h', '2025-12-31T12:34:00.000Z'],
  ] as const)('%s ends at now floored to the minute', (range, start) => {
    const window = resolveWindow(range, now);
    expect(window.end.toISOString()).toBe('2026-01-01T12:34:00.000Z');
    expect(window.start.toISOString()).toBe(start);
  });

  test('24h is exactly the API limit', () => {
    const w = resolveWindow('24h', now);
    expect(w.end.getTime() - w.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  test('buckets are per minute up to 3h and per hour for 24h', () => {
    expect(TIME_RANGES.map(bucketForRange)).toEqual([
      'minute',
      'minute',
      'minute',
      'minute',
      'hour',
    ]);
    expect(resolveWindow('3h', now).bucketMs).toBe(60_000);
    expect(resolveWindow('24h', now).bucketMs).toBe(3_600_000);
  });
});

