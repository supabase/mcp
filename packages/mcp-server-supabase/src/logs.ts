import { stripIndent } from 'common-tags';
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
    throw new Error(
      `Invalid iso_timestamp_end: "${iso_timestamp_end}". Expected an ISO 8601 timestamp.`
    );
  }

  const startMs = iso_timestamp_start
    ? Date.parse(iso_timestamp_start)
    : endMs - DAY_MS;
  if (Number.isNaN(startMs)) {
    throw new Error(
      `Invalid iso_timestamp_start: "${iso_timestamp_start}". Expected an ISO 8601 timestamp.`
    );
  }

  if (startMs >= endMs) {
    throw new Error('iso_timestamp_start must be before iso_timestamp_end.');
  }

  if (endMs - startMs > DAY_MS) {
    throw new Error('The log window can be at most 24 hours.');
  }

  return {
    iso_timestamp_start: new Date(startMs).toISOString(),
    iso_timestamp_end: new Date(endMs).toISOString(),
  };
}
