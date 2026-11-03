import { describe, expect, test } from 'vitest';
import { isToolCallerError } from './errors.js';
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
    expect(iso_timestamp_start).toBe('2024-01-31T11:00:00.000Z');
  });

  test('normalizes accepted timestamps to canonical UTC ISO strings', () => {
    const { iso_timestamp_start, iso_timestamp_end } = resolveLogWindow(
      '2024-02-01T09:00:00.000+01:00',
      '2024-02-01T11:00:00.000+01:00'
    );

    expect(iso_timestamp_start).toBe('2024-02-01T08:00:00.000Z');
    expect(iso_timestamp_end).toBe('2024-02-01T10:00:00.000Z');
  });

  test.each([
    {
      input: 'a malformed iso_timestamp_end',
      start: undefined,
      end: 'not-a-timestamp',
      message:
        'Invalid iso_timestamp_end: "not-a-timestamp". Expected an ISO 8601 timestamp.',
    },
    {
      input: 'a malformed iso_timestamp_start',
      start: 'not-a-timestamp',
      end: '2024-02-01T11:00:00.000Z',
      message:
        'Invalid iso_timestamp_start: "not-a-timestamp". Expected an ISO 8601 timestamp.',
    },
    {
      input: 'a start at or after the end',
      start: '2024-02-01T11:00:00.000Z',
      end: '2024-02-01T10:00:00.000Z',
      message: 'iso_timestamp_start must be before iso_timestamp_end.',
    },
    {
      input: 'a window longer than 24 hours',
      start: '2024-02-01T00:00:00.000Z',
      end: '2024-02-02T00:00:00.001Z',
      message: 'The log window can be at most 24 hours.',
    },
  ])('rejects $input as a caller error', ({ start, end, message }) => {
    let error: unknown;
    try {
      resolveLogWindow(start, end);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ message });
    expect(isToolCallerError(error)).toBe(true);
  });

  test('accepts a window exactly 24 hours long', () => {
    const start = '2024-02-01T00:00:00.000Z';
    const end = '2024-02-02T00:00:00.000Z';

    expect(() => resolveLogWindow(start, end)).not.toThrow();
  });
});
