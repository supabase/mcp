import { z } from 'zod/v4';
import type { TimeRange } from './constants.js';
import type { ReportWindow } from './queries.js';
import type { ApiGatewayReport, ReportPoint, ReportRoute } from './schema.js';

const MAX_ERROR_LENGTH = 300;

/** Coerces numbers and numeric strings; anything else (null, NaN, '') is null. */
const numeric = z.preprocess((value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}, z.number().nullable());

const timeseriesRowSchema = z.object({
  timestamp: z.union([z.number(), z.string()]),
  total: numeric,
  errors_4xx: numeric,
  errors_5xx: numeric,
  avg_ms: numeric,
  p95_ms: numeric,
});

const routeRowSchema = z.object({
  kind: z.string(),
  path: z.string().nullish(),
  method: z.string().nullish(),
  status_code: numeric,
  count: numeric,
  avg_ms: numeric,
  p95_ms: numeric,
});

/**
 * Extracts rows from a logs API body, `{ result?: unknown[]; error?: unknown }`.
 * An `error` field is a failure even when the HTTP status was 200.
 */
export function extractRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const { result, error } = body as { result?: unknown; error?: unknown };
    if (error !== undefined && error !== null && error !== '') {
      throw new Error(describeError(error));
    }
    if (Array.isArray(result)) return result;
    if (result === undefined || result === null) return [];
  }
  throw new Error('Unexpected logs response shape');
}

export function describeError(error: unknown): string {
  let message: string;
  if (typeof error === 'string') {
    message = error;
  } else if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === 'object') {
    const nested = (error as { message?: unknown }).message;
    message =
      typeof nested === 'string' ? nested : safeStringify(error as object);
  } else {
    message = String(error);
  }
  return message.length > MAX_ERROR_LENGTH
    ? `${message.slice(0, MAX_ERROR_LENGTH)}...`
    : message;
}

function safeStringify(value: object): string {
  try {
    return JSON.stringify(value);
  } catch {
    return 'Unknown error';
  }
}

/** Interprets a ClickHouse timestamp as epoch ms (µs, ms, s, or ISO string). */
function toEpochMs(value: number | string): number | null {
  let n: number | null = null;
  if (typeof value === 'number') {
    n = value;
  } else if (value.trim() !== '' && Number.isFinite(Number(value))) {
    n = Number(value);
  } else {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (n > 1e14) return Math.round(n / 1000); // microseconds
  if (n > 1e11) return Math.round(n); // milliseconds
  return Math.round(n * 1000); // seconds
}

/** Zero-fills every bucket in the window and merges the query rows in. */
export function buildTimeseries(
  body: unknown,
  window: ReportWindow
): ReportPoint[] {
  const rows = extractRows(body);
  const first = Math.floor(window.start.getTime() / window.bucketMs);
  const last = Math.floor((window.end.getTime() - 1) / window.bucketMs);

  const points = new Map<number, ReportPoint>();
  for (let b = first; b <= last; b++) {
    points.set(b, {
      timestamp: new Date(b * window.bucketMs).toISOString(),
      total: 0,
      errors4xx: 0,
      errors5xx: 0,
      avgMs: null,
      p95Ms: null,
    });
  }

  for (const raw of rows) {
    const parsed = timeseriesRowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;
    const ms = toEpochMs(row.timestamp);
    if (ms === null) continue;
    const point = points.get(Math.floor(ms / window.bucketMs));
    if (!point) continue; // outside the window
    point.total += row.total ?? 0;
    point.errors4xx += row.errors_4xx ?? 0;
    point.errors5xx += row.errors_5xx ?? 0;
    point.avgMs = row.avg_ms;
    point.p95Ms = row.p95_ms;
  }

  return [...points.entries()].sort(([a], [b]) => a - b).map(([, p]) => p);
}

export type RouteTables = {
  summary: { count: number; avgMs: number | null; p95Ms: number | null } | null;
  top: ReportRoute[];
  error: ReportRoute[];
  slow: ReportRoute[];
};

export function buildRouteTables(body: unknown): RouteTables {
  const rows = extractRows(body);
  const tables: RouteTables = { summary: null, top: [], error: [], slow: [] };

  for (const raw of rows) {
    const parsed = routeRowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;

    if (row.kind === 'summary') {
      tables.summary = {
        count: row.count ?? 0,
        avgMs: row.avg_ms,
        p95Ms: row.p95_ms,
      };
      continue;
    }
    if (row.kind !== 'top' && row.kind !== 'error' && row.kind !== 'slow') {
      continue;
    }
    const route: ReportRoute = {
      method: row.method ?? '',
      path: row.path ?? '',
      statusCode:
        row.kind === 'error' && row.status_code ? row.status_code : null,
      count: row.count ?? 0,
      avgMs: row.avg_ms,
      p95Ms: row.p95_ms,
    };
    tables[row.kind].push(route);
  }

  // UNION ALL gives no ordering guarantee across branches.
  tables.top.sort((a, b) => b.count - a.count);
  tables.error.sort((a, b) => b.count - a.count);
  tables.slow.sort((a, b) => (b.avgMs ?? -1) - (a.avgMs ?? -1));
  return tables;
}

export type SettledQuery = PromiseSettledResult<unknown>;

/** Builds the report payload from the two settled logs calls. */
export function buildReport(input: {
  projectId: string;
  timeRange: TimeRange;
  window: ReportWindow;
  now: Date;
  timeseries: SettledQuery;
  routes: SettledQuery;
}): ApiGatewayReport {
  const { window } = input;

  let points: ReportPoint[] = [];
  let timeseriesError: string | undefined;
  if (input.timeseries.status === 'fulfilled') {
    try {
      points = buildTimeseries(input.timeseries.value, window);
    } catch (error) {
      timeseriesError = describeError(error);
    }
  } else {
    timeseriesError = describeError(input.timeseries.reason);
  }

  let tables: RouteTables = { summary: null, top: [], error: [], slow: [] };
  let routesError: string | undefined;
  if (input.routes.status === 'fulfilled') {
    try {
      tables = buildRouteTables(input.routes.value);
    } catch (error) {
      routesError = describeError(error);
    }
  } else {
    routesError = describeError(input.routes.reason);
  }

  const haveSeries = timeseriesError === undefined;
  const errors4xx = haveSeries ? sum(points, (p) => p.errors4xx) : null;
  const errors5xx = haveSeries ? sum(points, (p) => p.errors5xx) : null;
  const totalRequests = haveSeries
    ? sum(points, (p) => p.total)
    : (tables.summary?.count ?? null);
  const errorRatePercent =
    totalRequests && errors4xx !== null && errors5xx !== null
      ? ((errors4xx + errors5xx) / totalRequests) * 100
      : totalRequests === 0
        ? 0
        : null;

  return {
    projectId: input.projectId,
    timeRange: input.timeRange,
    generatedAt: input.now.toISOString(),
    window: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      bucket: window.bucket,
    },
    summary: {
      totalRequests,
      errors4xx,
      errors5xx,
      errorRatePercent,
      avgMs: tables.summary?.avgMs ?? null,
      p95Ms: tables.summary?.p95Ms ?? null,
    },
    timeseries: {
      rows: points,
      ...(timeseriesError && { error: timeseriesError }),
    },
    topRoutes: { rows: tables.top, ...(routesError && { error: routesError }) },
    topErrorRoutes: {
      rows: tables.error,
      ...(routesError && { error: routesError }),
    },
    slowestRoutes: {
      rows: tables.slow,
      ...(routesError && { error: routesError }),
    },
  };
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
