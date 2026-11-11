import type { TimeRange } from './constants.js';

/**
 * ClickHouse (`.otel`) queries for the API gateway report, ported from the
 * `safeSqlOtel` presets in Studio's
 * `components/interfaces/Reports/Reports.constants.ts`. All inputs are enums,
 * so no user-provided string ever reaches the SQL; the time window is passed
 * as `iso_timestamp_start` / `iso_timestamp_end`, never inlined.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const RANGE_MS: Record<TimeRange, number> = {
  '10m': 10 * MINUTE_MS,
  '30m': 30 * MINUTE_MS,
  '1h': HOUR_MS,
  '3h': 3 * HOUR_MS,
  '24h': 24 * HOUR_MS,
};

export type Bucket = 'minute' | 'hour';

export type ReportWindow = {
  /** Inclusive start, `end - range`. */
  start: Date;
  /** Exclusive end: `now` floored to the minute. */
  end: Date;
  bucket: Bucket;
  bucketMs: number;
};

/** Minute buckets up to 3h, hourly buckets for 24h. */
export function bucketForRange(range: TimeRange): Bucket {
  return range === '24h' ? 'hour' : 'minute';
}

export function resolveWindow(range: TimeRange, now: Date): ReportWindow {
  const endMs = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const bucket = bucketForRange(range);
  return {
    start: new Date(endMs - RANGE_MS[range]),
    end: new Date(endMs),
    bucket,
    bucketMs: bucket === 'hour' ? HOUR_MS : MINUTE_MS,
  };
}

// Column expressions, identical to Studio's OTEL_* constants.
const OTEL_STATUS_CODE = `toInt32OrZero(log_attributes['response.status_code'])`;
// Studio measures latency with `response.origin_time` (ms between the gateway
// and the upstream service). We use the same attribute for avg and p95.
const OTEL_ORIGIN_TIME = `toFloat64OrNull(log_attributes['response.origin_time'])`;
const OTEL_PATH = `log_attributes['request.path']`;
const OTEL_METHOD = `log_attributes['request.method']`;

function otelTimestamp(bucket: Bucket): string {
  // Same expression as Studio's OTEL_TIMESTAMP (microseconds since epoch).
  return bucket === 'hour'
    ? 'toUnixTimestamp(toStartOfHour(logs.timestamp)) * 1000000'
    : 'toUnixTimestamp(toStartOfMinute(logs.timestamp)) * 1000000';
}

/**
 * Query 1: time series. Merges Studio's `totalRequests`, `errorCounts` and
 * `responseSpeed` presets into one pass over the logs, adding p95 latency.
 */
export function timeseriesQuery(bucket: Bucket): string {
  const ts = otelTimestamp(bucket);
  return `
select
  ${ts} as timestamp,
  toFloat64(count()) as total,
  toFloat64(countIf(${OTEL_STATUS_CODE} >= 400 and ${OTEL_STATUS_CODE} < 500)) as errors_4xx,
  toFloat64(countIf(${OTEL_STATUS_CODE} >= 500 and ${OTEL_STATUS_CODE} < 600)) as errors_5xx,
  avg(${OTEL_ORIGIN_TIME}) as avg_ms,
  quantile(0.95)(${OTEL_ORIGIN_TIME}) as p95_ms
from logs
where source = 'edge_logs'
group by ${ts}
order by ${ts} asc
limit 1000`.trim();
}

const STATS = `toFloat64(count()) as count,
    avg(${OTEL_ORIGIN_TIME}) as avg_ms,
    quantile(0.95)(${OTEL_ORIGIN_TIME}) as p95_ms`;

/**
 * Query 2: window-wide summary plus the three route tables, combined with
 * `UNION ALL` into one logs call (the `kind` column tells the rows apart).
 * Every branch selects the same columns in the same order and is wrapped in
 * `select * from (...)` so each `order by ... limit` stays scoped to its branch.
 *
 * - summary: one row with the overall count and avg / p95 latency (p95 cannot
 *   be derived from per-bucket p95s).
 * - top: busiest routes, grouped by method + path (Studio also groups by
 *   status code and query string; we drop both so a route is one row and
 *   query strings, which can hold secrets, are never read).
 * - error: routes with status >= 400, grouped by method + path + status code
 *   as in Studio, ordered by count.
 * - slow: routes with a measured origin time, ordered by average latency
 *   (Studio's choice; p95 is shown alongside).
 */
export function routesQuery(): string {
  return `
select kind, path, method, status_code, count, avg_ms, p95_ms from (
  select
    'summary' as kind,
    '' as path,
    '' as method,
    toInt32(0) as status_code,
    ${STATS}
  from logs
  where source = 'edge_logs'
)
union all
select kind, path, method, status_code, count, avg_ms, p95_ms from (
  select
    'top' as kind,
    ${OTEL_PATH} as path,
    ${OTEL_METHOD} as method,
    toInt32(0) as status_code,
    ${STATS}
  from logs
  where source = 'edge_logs'
  group by ${OTEL_PATH}, ${OTEL_METHOD}
  order by count desc
  limit 10
)
union all
select kind, path, method, status_code, count, avg_ms, p95_ms from (
  select
    'error' as kind,
    ${OTEL_PATH} as path,
    ${OTEL_METHOD} as method,
    ${OTEL_STATUS_CODE} as status_code,
    ${STATS}
  from logs
  where source = 'edge_logs' and ${OTEL_STATUS_CODE} >= 400
  group by ${OTEL_PATH}, ${OTEL_METHOD}, ${OTEL_STATUS_CODE}
  order by count desc
  limit 10
)
union all
select kind, path, method, status_code, count, avg_ms, p95_ms from (
  select
    'slow' as kind,
    ${OTEL_PATH} as path,
    ${OTEL_METHOD} as method,
    toInt32(0) as status_code,
    ${STATS}
  from logs
  where source = 'edge_logs' and isNotNull(${OTEL_ORIGIN_TIME})
  group by ${OTEL_PATH}, ${OTEL_METHOD}
  order by avg_ms desc
  limit 10
)`.trim();
}
