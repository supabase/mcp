import { stripIndent } from 'common-tags';
import { ToolCallerError } from '@supabase/mcp-utils';
import type { LogsService } from './platform/types.js';

export function getClickHouseLogQuery(
  service: LogsService,
  limit: number = 100
) {
  switch (service) {
    case 'api':
      return stripIndent`
        select id, log_attributes['identifier'] as identifier, timestamp, event_message, log_attributes['request.method'] as method, log_attributes['request.path'] as path, log_attributes['response.status_code'] as status_code
        from logs
        where source = 'edge_logs'
        order by timestamp desc
        limit ${limit}
      `;
    case 'branch-action':
      return stripIndent`
        select log_attributes['workflow_run'] as workflow_run, timestamp, id, event_message
        from logs
        where source = 'workflow_run_logs'
        order by timestamp desc
        limit ${limit}
      `;
    case 'postgres':
      return stripIndent`
        select log_attributes['identifier'] as identifier, timestamp, id, event_message, log_attributes['parsed.error_severity'] as error_severity
        from logs
        where source = 'postgres_logs'
        order by timestamp desc
        limit ${limit}
      `;
    case 'edge-function':
      return stripIndent`
        select id, timestamp, event_message, log_attributes['response.status_code'] as status_code, log_attributes['request.method'] as method, log_attributes['function_id'] as function_id, log_attributes['execution_time_ms'] as execution_time_ms, log_attributes['deployment_id'] as deployment_id, log_attributes['version'] as version
        from logs
        where source = 'function_edge_logs'
        order by timestamp desc
        limit ${limit}
      `;
    case 'edge-function-runtime':
      return stripIndent`
        select id, timestamp, event_message, severity_text, log_attributes['level'] as level, log_attributes['event_type'] as event_type, log_attributes['function_id'] as function_id, log_attributes['execution_id'] as execution_id, log_attributes['deployment_id'] as deployment_id, log_attributes['version'] as version
        from logs
        where source = 'function_logs'
        order by timestamp desc
        limit ${limit}
      `;
    case 'auth':
      return stripIndent`
        select id, timestamp, event_message, log_attributes['level'] as level, log_attributes['status'] as status, log_attributes['path'] as path, log_attributes['msg'] as msg, log_attributes['error'] as error
        from logs
        where source = 'auth_logs'
        order by timestamp desc
        limit ${limit}
      `;
    case 'storage':
      return stripIndent`
        select id, timestamp, event_message
        from logs
        where source = 'storage_logs'
        order by timestamp desc
        limit ${limit}
      `;
    case 'realtime':
      return stripIndent`
        select id, timestamp, event_message
        from logs
        where source = 'realtime_logs'
        order by timestamp desc
        limit ${limit}
      `;
    default:
      throw new Error(`unsupported log service type: ${service}`);
  }
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveLogWindow(
  iso_timestamp_start?: string,
  iso_timestamp_end?: string
) {
  const endMs = iso_timestamp_end ? Date.parse(iso_timestamp_end) : Date.now();
  if (Number.isNaN(endMs)) {
    throw new ToolCallerError(
      `Invalid iso_timestamp_end: "${iso_timestamp_end}". Expected an ISO 8601 timestamp.`
    );
  }

  const startMs = iso_timestamp_start
    ? Date.parse(iso_timestamp_start)
    : endMs - DAY_MS;
  if (Number.isNaN(startMs)) {
    throw new ToolCallerError(
      `Invalid iso_timestamp_start: "${iso_timestamp_start}". Expected an ISO 8601 timestamp.`
    );
  }

  if (startMs >= endMs) {
    throw new ToolCallerError(
      'iso_timestamp_start must be before iso_timestamp_end.'
    );
  }

  if (endMs - startMs > DAY_MS) {
    throw new ToolCallerError('The log window can be at most 24 hours.');
  }

  return {
    iso_timestamp_start: new Date(startMs).toISOString(),
    iso_timestamp_end: new Date(endMs).toISOString(),
  };
}

/** Sources in the unified `logs` table that `show_logs` can filter to. */
export const LOG_EVENT_SOURCES = [
  'edge_logs',
  'postgres_logs',
  'auth_logs',
  'storage_logs',
  'realtime_logs',
  'function_edge_logs',
  'function_logs',
  'postgrest_logs',
  'pgbouncer_logs',
] as const;

export const LOG_EVENT_LEVELS = ['error', 'warning', 'info'] as const;

/** Most events `show_logs` reads. */
export const LOG_EVENT_LIMIT = 100;

// Follows Studio's unified logs. Gateway, auth and storage rows report
// severity_text INFO whatever their response, so the HTTP status decides
// first and severity applies only to rows without one. Expressions are
// inlined because the logs endpoint can't filter on derived aliases.
const httpStatusSql =
  "CASE WHEN source = 'auth_logs' THEN log_attributes['status'] WHEN source = 'storage_logs' THEN log_attributes['res.statusCode'] ELSE log_attributes['response.status_code'] END";
const logLevelSql = `CASE WHEN toInt32OrZero(${httpStatusSql}) >= 500 THEN 'error' WHEN toInt32OrZero(${httpStatusSql}) BETWEEN 400 AND 499 THEN 'warning' WHEN toInt32OrZero(${httpStatusSql}) BETWEEN 200 AND 299 THEN 'info' WHEN upper(severity_text) IN ('ERROR', 'FATAL', 'PANIC', 'CRITICAL', 'ALERT', 'EMERGENCY') THEN 'error' WHEN upper(severity_text) IN ('WARNING', 'WARN') THEN 'warning' ELSE 'info' END`;
const logColumnsSql = `id, timestamp, source, severity_text, (${logLevelSql}) AS level, (CASE WHEN source = 'postgres_logs' THEN log_attributes['parsed.sql_state_code'] ELSE ${httpStatusSql} END) AS status, if(source = 'storage_logs', log_attributes['req.method'], log_attributes['request.method']) AS method, if(source = 'storage_logs', log_attributes['req.url'], log_attributes['request.path']) AS path, event_message`;

/**
 * The latest events across the unified `logs` table (ClickHouse), with the
 * level, status, method and path Studio's unified logs show. `source` and
 * `level` come from fixed lists, so they're safe to inline.
 */
export function logEventsSql({
  source = 'all',
  level = 'all',
}: {
  source?: 'all' | 'edge_functions' | (typeof LOG_EVENT_SOURCES)[number];
  level?: 'all' | (typeof LOG_EVENT_LEVELS)[number];
}) {
  const where = [
    source === 'all'
      ? undefined
      : source === 'edge_functions'
        ? "source IN ('function_edge_logs', 'function_logs')"
        : `source = '${source}'`,
    level === 'all' ? undefined : `(${logLevelSql}) = '${level}'`,
  ].filter(Boolean);
  return `SELECT ${logColumnsSql} FROM logs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY timestamp DESC LIMIT ${LOG_EVENT_LIMIT}`;
}
