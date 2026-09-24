import { describe, expect, test } from 'vitest';
import { DAY_MS, getClickHouseLogQuery, resolveLogWindow } from './logs.js';
import type { LogsService } from './platform/types.js';

const serviceSources = {
  api: 'edge_logs',
  'branch-action': 'workflow_run_logs',
  postgres: 'postgres_logs',
  'edge-function': 'function_edge_logs',
  'edge-function-runtime': 'function_logs',
  auth: 'auth_logs',
  storage: 'storage_logs',
  realtime: 'realtime_logs',
} as const satisfies Record<LogsService, string>;

describe('getClickHouseLogQuery', () => {
  test.each(Object.entries(serviceSources))(
    'queries logs table for %s logs',
    (service, source) => {
      const query = getClickHouseLogQuery(service as LogsService);

      expect(query).toContain('from logs');
      expect(query).toContain(`where source = '${source}'`);
      expect(query).toContain('order by timestamp desc');
      expect(query).toContain('limit 100');
      expect(query).not.toContain('select *');
    }
  );

  test('queries runtime logs fields without invocation request fields', () => {
    const query = getClickHouseLogQuery('edge-function-runtime');

    expect(query).toContain('severity_text');
    expect(query).toContain("log_attributes['level'] as level");
    expect(query).toContain("log_attributes['event_type'] as event_type");
    expect(query).toContain("log_attributes['execution_id'] as execution_id");
    expect(query).not.toContain("log_attributes['request.method']");
    expect(query).not.toContain("log_attributes['response.status_code']");
  });
});

describe('resolveLogWindow', () => {
  test('defaults the end to now and the start to 24 hours before it', () => {
    const before = Date.now();
    const { iso_timestamp_start, iso_timestamp_end } = resolveLogWindow();
    const after = Date.now();

    const endMs = Date.parse(iso_timestamp_end);
    const startMs = Date.parse(iso_timestamp_start);

    expect(endMs).toBeGreaterThanOrEqual(before);
    expect(endMs).toBeLessThanOrEqual(after);
    expect(startMs).toBe(endMs - DAY_MS);
  });

  test('anchors the default start to a supplied end', () => {
    const end = '2024-02-01T11:00:00.000Z';
    const { iso_timestamp_start, iso_timestamp_end } = resolveLogWindow(
      undefined,
      end
    );

    expect(iso_timestamp_end).toBe(end);
    expect(iso_timestamp_start).toBe(
      new Date(Date.parse(end) - DAY_MS).toISOString()
    );
  });

  test('normalizes accepted timestamps to canonical UTC ISO strings', () => {
    const { iso_timestamp_start, iso_timestamp_end } = resolveLogWindow(
      '2024-02-01T09:00:00.000+01:00',
      '2024-02-01T11:00:00.000+01:00'
    );

    expect(iso_timestamp_start).toBe('2024-02-01T08:00:00.000Z');
    expect(iso_timestamp_end).toBe('2024-02-01T10:00:00.000Z');
  });

  test('rejects a malformed iso_timestamp_end', () => {
    expect(() => resolveLogWindow(undefined, 'not-a-timestamp')).toThrow(
      /Invalid iso_timestamp_end/
    );
  });

  test('rejects a malformed iso_timestamp_start', () => {
    expect(() =>
      resolveLogWindow('not-a-timestamp', '2024-02-01T11:00:00.000Z')
    ).toThrow(/Invalid iso_timestamp_start/);
  });

  test('rejects a start at or after the end', () => {
    expect(() =>
      resolveLogWindow('2024-02-01T11:00:00.000Z', '2024-02-01T10:00:00.000Z')
    ).toThrow(/must be before/);
  });

  test('rejects a window longer than 24 hours', () => {
    expect(() =>
      resolveLogWindow('2024-02-01T00:00:00.000Z', '2024-02-02T00:00:00.001Z')
    ).toThrow(/at most 24 hours/);
  });

  test('accepts a window exactly 24 hours long', () => {
    const start = '2024-02-01T00:00:00.000Z';
    const end = '2024-02-02T00:00:00.000Z';

    expect(() => resolveLogWindow(start, end)).not.toThrow();
  });
});
