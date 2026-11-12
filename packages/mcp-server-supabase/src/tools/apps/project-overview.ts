import { z } from 'zod/v4';
import type { DebuggingOperations } from '../../platform/types.js';

// One gateway event per observed request; adding service logs double-counts traffic.
// Field names and status semantics follow the observability detection checks.
function projectTrafficSql(start: string, end: string) {
  return `SELECT
  toUnixTimestamp(hour) * 1000 AS timestamp,
  count() AS requests,
  countIf(status BETWEEN 100 AND 599) AS responses,
  countIf(status BETWEEN 400 AND 599) AS errors
FROM (
  SELECT toStartOfHour(timestamp) AS hour, toInt32OrNull(log_attributes['response.status_code']) AS status
  FROM logs WHERE source = 'edge_logs'
    AND timestamp >= parseDateTime64BestEffort('${start}')
    AND timestamp < parseDateTime64BestEffort('${end}')
)
GROUP BY hour ORDER BY hour LIMIT 24`;
}

const count = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform((value) => Number(value))
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const trafficRows = z
  .array(
    z.object({
      timestamp: count,
      requests: count,
      responses: count,
      errors: count,
    })
  )
  .max(24);
const advisorResult = z.object({
  lints: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      level: z.enum(['INFO', 'WARN', 'ERROR']),
    })
  ),
});

const userCountRows = z.array(z.object({ total: count })).length(1);

/** Counts a project's Auth users. Returns only the total, never user data. */
export const USER_COUNT_SQL = 'select count(*) as total from auth.users';

export async function readProjectOverview(
  projectId: string,
  debugging: DebuggingOperations | undefined,
  now = new Date(),
  /** Runs read-only SQL against the project's database. Omit when the connection has none. */
  readDatabase?: (query: string) => Promise<unknown>
) {
  // Complete UTC hours keep the chart comparable and the query within the 24h cap.
  const hour = 3_600_000;
  const end = Math.floor(now.getTime() / hour) * hour;
  const start = end - 24 * hour;
  async function section<T>(read: (() => Promise<T>) | undefined) {
    if (!read)
      return {
        status: 'unavailable' as const,
        message: 'Not available on this connection.',
      };
    try {
      return { status: 'ready' as const, data: await read() };
    } catch {
      // Do not turn denied access or malformed data into a zero/healthy reading.
      return {
        status: 'unavailable' as const,
        message:
          'Could not load this data. Check project access and try refreshing.',
      };
    }
  }
  async function advisors(type: 'security' | 'performance') {
    const result = await (type === 'security'
      ? debugging!.getSecurityAdvisors(projectId)
      : debugging!.getPerformanceAdvisors(projectId));
    const { lints } = advisorResult.parse(result);
    const groups = new Map<
      string,
      { name: string; title: string; level: 'WARN' | 'ERROR'; count: number }
    >();
    for (const lint of lints) {
      if (lint.level === 'INFO') continue;
      const key = JSON.stringify([lint.name, lint.title, lint.level]);
      const previous = groups.get(key);
      if (previous) previous.count++;
      else groups.set(key, { ...lint, level: lint.level, count: 1 });
    }
    const issues = [...groups.values()].sort(
      (a, b) =>
        (a.level === 'ERROR' ? 0 : 1) - (b.level === 'ERROR' ? 0 : 1) ||
        a.title.localeCompare(b.title)
    );
    return {
      total: issues.reduce((sum, issue) => sum + issue.count, 0),
      issues: issues.slice(0, 20),
      truncated: issues.length > 20,
    };
  }
  const [traffic, security, performance, users] = await Promise.all([
    section(
      debugging?.queryLogs &&
        (debugging.logsDialect ?? 'clickhouse') === 'clickhouse'
        ? async () => {
            const result = await debugging.queryLogs!(projectId, {
              sql: projectTrafficSql(
                new Date(start).toISOString(),
                new Date(end).toISOString()
              ),
              iso_timestamp_start: new Date(start).toISOString(),
              iso_timestamp_end: new Date(end).toISOString(),
            });
            const rows = trafficRows.parse(
              Array.isArray(result)
                ? result
                : z.object({ result: z.unknown() }).parse(result).result
            );
            const buckets = new Map(rows.map((row) => [row.timestamp, row]));
            if (
              buckets.size !== rows.length ||
              rows.some(
                (row) =>
                  row.timestamp < start ||
                  row.timestamp >= end ||
                  row.timestamp % hour !== 0 ||
                  row.errors > row.responses ||
                  row.responses > row.requests
              )
            )
              throw new Error('Invalid traffic aggregates');
            const totals = rows.reduce(
              (sum, row) => ({
                requests: sum.requests + row.requests,
                responses: sum.responses + row.responses,
                errors: sum.errors + row.errors,
              }),
              { requests: 0, responses: 0, errors: 0 }
            );
            return {
              ...totals,
              unknownStatus: totals.requests - totals.responses,
              errorRate: totals.responses
                ? (100 * totals.errors) / totals.responses
                : null,
              points: Array.from({ length: 24 }, (_, i) => {
                const timestamp = start + i * hour;
                const row = buckets.get(timestamp);
                return {
                  timestamp,
                  requests: row?.requests ?? 0,
                  errorRate: row?.responses
                    ? (100 * row.errors) / row.responses
                    : null,
                };
              }),
            };
          }
        : undefined
    ),
    section(debugging ? () => advisors('security') : undefined),
    section(debugging ? () => advisors('performance') : undefined),
    section(
      readDatabase
        ? async () => {
            const [row] = userCountRows.parse(
              await readDatabase(USER_COUNT_SQL)
            );
            return { total: row!.total };
          }
        : undefined
    ),
  ]);
  return {
    projectId,
    observedAt: now.toISOString(),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    traffic,
    security,
    performance,
    users,
  };
}
