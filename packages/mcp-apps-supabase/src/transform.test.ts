import { describe, expect, test } from 'vitest';
import { apiGatewayReportSchema } from './schema.js';
import { resolveWindow } from './queries.js';
import {
  buildReport,
  buildRouteTables,
  buildTimeseries,
  describeError,
  extractRows,
} from './transform.js';

const NOW = new Date('2026-01-01T12:34:56.000Z');
const micros = (iso: string) => Date.parse(iso) * 1000;

describe('extractRows', () => {
  test('returns result rows', () => {
    expect(extractRows({ result: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });

  test('missing result is empty', () => {
    expect(extractRows({})).toEqual([]);
  });

  test('an error field fails even with a result', () => {
    expect(() =>
      extractRows({ result: [], error: { message: 'boom' } })
    ).toThrow('boom');
    expect(() => extractRows({ error: 'bad sql' })).toThrow('bad sql');
  });

  test('rejects unexpected shapes', () => {
    expect(() => extractRows('nope')).toThrow(/Unexpected/);
  });

  test('truncates long errors', () => {
    expect(describeError('x'.repeat(1000)).length).toBeLessThan(400);
  });
});

describe('buildTimeseries', () => {
  const window = resolveWindow('10m', NOW);

  test('zero-fills every minute bucket across the window', () => {
    const points = buildTimeseries({ result: [] }, window);
    expect(points).toHaveLength(10);
    expect(points[0]!.timestamp).toBe('2026-01-01T12:24:00.000Z');
    expect(points[9]!.timestamp).toBe('2026-01-01T12:33:00.000Z');
    expect(points.every((p) => p.total === 0 && p.avgMs === null)).toBe(true);
  });

  test('merges rows, coercing numeric strings and microsecond timestamps', () => {
    const points = buildTimeseries(
      {
        result: [
          {
            timestamp: String(micros('2026-01-01T12:30:00Z')),
            total: '12',
            errors_4xx: 2,
            errors_5xx: '1',
            avg_ms: '34.5',
            p95_ms: 120,
          },
          {
            timestamp: micros('2026-01-01T12:31:00Z'),
            total: 5,
            errors_4xx: 0,
            errors_5xx: 0,
            avg_ms: null,
            p95_ms: 'NaN',
          },
        ],
      },
      window
    );
    const at = (iso: string) => points.find((p) => p.timestamp === iso)!;
    expect(at('2026-01-01T12:30:00.000Z')).toMatchObject({
      total: 12,
      errors4xx: 2,
      errors5xx: 1,
      avgMs: 34.5,
      p95Ms: 120,
    });
    expect(at('2026-01-01T12:31:00.000Z')).toMatchObject({
      total: 5,
      avgMs: null,
      p95Ms: null,
    });
    expect(points).toHaveLength(10);
  });

  test('ignores rows outside the window and malformed rows', () => {
    const points = buildTimeseries(
      {
        result: [
          { timestamp: micros('2026-01-01T09:00:00Z'), total: 99 },
          { total: 3 },
          'garbage',
        ],
      },
      window
    );
    expect(points.reduce((s, p) => s + p.total, 0)).toBe(0);
  });

  test('hourly buckets for 24h', () => {
    const w = resolveWindow('24h', NOW);
    const points = buildTimeseries({ result: [] }, w);
    expect(points[0]!.timestamp).toBe('2025-12-31T12:00:00.000Z');
    expect(points.at(-1)!.timestamp).toBe('2026-01-01T12:00:00.000Z');
    expect(points).toHaveLength(25);
  });
});

describe('buildRouteTables', () => {
  test('splits rows by kind and sorts', () => {
    const tables = buildRouteTables({
      result: [
        {
          kind: 'top',
          path: '/b',
          method: 'GET',
          status_code: 0,
          count: '2',
          avg_ms: 1,
          p95_ms: 2,
        },
        {
          kind: 'top',
          path: '/a',
          method: 'GET',
          status_code: 0,
          count: '9',
          avg_ms: 1,
          p95_ms: 2,
        },
        {
          kind: 'error',
          path: '/a',
          method: 'POST',
          status_code: '500',
          count: 3,
          avg_ms: null,
          p95_ms: null,
        },
        {
          kind: 'slow',
          path: '/s',
          method: 'GET',
          status_code: 0,
          count: 1,
          avg_ms: 900,
          p95_ms: 900,
        },
        {
          kind: 'summary',
          path: '',
          method: '',
          status_code: 0,
          count: 11,
          avg_ms: 12.5,
          p95_ms: 80,
        },
        { kind: 'other', count: 1 },
      ],
    });
    expect(tables.top.map((r) => r.path)).toEqual(['/a', '/b']);
    expect(tables.error[0]).toMatchObject({
      method: 'POST',
      statusCode: 500,
      count: 3,
    });
    expect(tables.top[0]!.statusCode).toBeNull();
    expect(tables.slow[0]).toMatchObject({ avgMs: 900 });
    expect(tables.summary).toEqual({ count: 11, avgMs: 12.5, p95Ms: 80 });
  });
});

describe('buildReport', () => {
  const window = resolveWindow('10m', NOW);
  const ok = (value: unknown) =>
    ({ status: 'fulfilled', value }) as PromiseFulfilledResult<unknown>;
  const fail = (reason: unknown) =>
    ({ status: 'rejected', reason }) as PromiseRejectedResult;

  const series = {
    result: [
      {
        timestamp: micros('2026-01-01T12:30:00Z'),
        total: 90,
        errors_4xx: 6,
        errors_5xx: 4,
        avg_ms: 10,
        p95_ms: 50,
      },
    ],
  };
  const routes = {
    result: [
      {
        kind: 'summary',
        count: 90,
        avg_ms: 11,
        p95_ms: 55,
        status_code: 0,
        path: '',
        method: '',
      },
      {
        kind: 'top',
        path: '/rest/v1/x',
        method: 'GET',
        status_code: 0,
        count: 80,
        avg_ms: 10,
        p95_ms: 50,
      },
    ],
  };

  const build = (
    a: PromiseSettledResult<unknown>,
    b: PromiseSettledResult<unknown>
  ) =>
    buildReport({
      projectId: 'p',
      timeRange: '10m',
      window,
      now: NOW,
      timeseries: a,
      routes: b,
    });

  test('computes summary numbers and satisfies the schema', () => {
    const report = build(ok(series), ok(routes));
    expect(apiGatewayReportSchema.parse(report)).toEqual(report);
    expect(report.summary).toEqual({
      totalRequests: 90,
      errors4xx: 6,
      errors5xx: 4,
      errorRatePercent: (10 / 90) * 100,
      avgMs: 11,
      p95Ms: 55,
    });
    expect(report.timeseries.error).toBeUndefined();
  });

  test('a failed series query leaves the tables intact', () => {
    const report = build(fail(new Error('series down')), ok(routes));
    expect(report.timeseries.error).toBe('series down');
    expect(report.timeseries.rows).toEqual([]);
    expect(report.topRoutes.error).toBeUndefined();
    expect(report.summary.totalRequests).toBe(90);
    expect(report.summary.errors4xx).toBeNull();
    expect(report.summary.errorRatePercent).toBeNull();
    expect(apiGatewayReportSchema.safeParse(report).success).toBe(true);
  });

  test('a failed route query (including an error field) keeps the series', () => {
    const report = build(ok(series), ok({ error: 'no union' }));
    expect(report.topRoutes.error).toBe('no union');
    expect(report.topErrorRoutes.error).toBe('no union');
    expect(report.slowestRoutes.error).toBe('no union');
    expect(report.summary.totalRequests).toBe(90);
    expect(report.summary.p95Ms).toBeNull();
  });

  test('no traffic yields a zero error rate', () => {
    const report = build(ok({ result: [] }), ok({ result: [] }));
    expect(report.summary.totalRequests).toBe(0);
    expect(report.summary.errorRatePercent).toBe(0);
  });
});
