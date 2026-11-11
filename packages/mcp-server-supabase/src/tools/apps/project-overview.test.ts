import { afterEach, expect, test, vi } from 'vitest';
import type {
  DebuggingOperations,
  SupabasePlatform,
} from '../../platform/types.js';
import { readProjectOverview } from './project-overview.js';
import { createServerHarness } from '../../../test/server-harness.js';

const now = new Date('2026-10-23T02:35:00.000Z');
const start = Date.parse('2026-10-22T02:00:00.000Z');
function fixture() {
  return {
    getLogs: vi.fn(),
    queryLogs: vi.fn().mockResolvedValue({
      result: [
        { timestamp: start, requests: '100', responses: '90', errors: '9' },
        {
          timestamp: start + 3600000,
          requests: 900,
          responses: 900,
          errors: 0,
        },
      ],
    }),
    getSecurityAdvisors: vi.fn().mockResolvedValue({
      lints: [
        { name: 'warning', title: 'Warning', level: 'WARN' },
        {
          name: 'rls',
          title: 'RLS disabled',
          level: 'ERROR',
          detail: 'private details',
        },
        { name: 'rls', title: 'RLS disabled', level: 'ERROR' },
        { name: 'unused', title: 'Unused index', level: 'INFO' },
      ],
    }),
    getPerformanceAdvisors: vi.fn().mockResolvedValue({ lints: [] }),
  } satisfies DebuggingOperations;
}

test('traffic uses weighted known-response rates, complete UTC hours, and gateway-only counts', async () => {
  const debugging = fixture();
  const result = await readProjectOverview('project', debugging, now);
  expect(result.traffic.status).toBe('ready');
  if (result.traffic.status !== 'ready') throw new Error('Missing traffic');
  expect(result.traffic.data).toMatchObject({
    requests: 1000,
    responses: 990,
    errors: 9,
    unknownStatus: 10,
    errorRate: (100 * 9) / 990,
  });
  expect(result.traffic.data.points).toHaveLength(24);
  expect(result.traffic.data.points[0]?.errorRate).toBe(10);
  expect(result.traffic.data.points[2]).toEqual({
    timestamp: start + 7200000,
    requests: 0,
    errorRate: null,
  });
  expect(debugging.queryLogs).toHaveBeenCalledOnce();
  expect(debugging.queryLogs).toHaveBeenCalledWith('project', {
    sql: expect.stringContaining("FROM logs WHERE source = 'edge_logs'"),
    iso_timestamp_start: '2026-10-22T02:00:00.000Z',
    iso_timestamp_end: '2026-10-23T02:00:00.000Z',
  });
  expect(debugging.queryLogs.mock.calls[0]![1].sql).toContain(
    "timestamp < parseDateTime64BestEffort('2026-10-23T02:00:00.000Z')"
  );
  expect(result.security).toEqual({
    status: 'ready',
    data: {
      total: 3,
      truncated: false,
      issues: [
        { name: 'rls', title: 'RLS disabled', level: 'ERROR', count: 2 },
        { name: 'warning', title: 'Warning', level: 'WARN', count: 1 },
      ],
    },
  });
});

test('partial permission failures do not hide independent sections or claim healthy', async () => {
  const debugging = fixture();
  debugging.getSecurityAdvisors.mockRejectedValue(new Error('Forbidden'));
  debugging.queryLogs.mockRejectedValue(new Error('Forbidden'));
  const result = await readProjectOverview('project', debugging, now);
  expect(result.traffic.status).toBe('unavailable');
  expect(result.security.status).toBe('unavailable');
  expect(result.performance).toEqual({
    status: 'ready',
    data: { total: 0, issues: [], truncated: false },
  });
});

test.each([
  null,
  { result: null },
  { result: [{ timestamp: start, requests: null, responses: 0, errors: 0 }] },
  { result: [{ timestamp: start, requests: 10, responses: 2, errors: 3 }] },
  {
    result: [
      { timestamp: start - 3600000, requests: 1, responses: 1, errors: 0 },
    ],
  },
])('malformed traffic is unavailable: %j', async (value) => {
  const debugging = fixture();
  debugging.queryLogs.mockResolvedValue(value);
  expect(
    (await readProjectOverview('project', debugging, now)).traffic.status
  ).toBe('unavailable');
});

test('no traffic does not imply a zero error rate', async () => {
  const debugging = fixture();
  debugging.queryLogs.mockResolvedValue({ result: [] });
  const result = await readProjectOverview('project', debugging, now);
  expect(result.traffic).toMatchObject({
    status: 'ready',
    data: { requests: 0, errorRate: null },
  });
});

test('unsupported log dialect still supports advisors; disabled debugging makes no reads', async () => {
  const debugging = { ...fixture(), logsDialect: 'bigquery' as const };
  const result = await readProjectOverview('project', debugging, now);
  expect(debugging.queryLogs).not.toHaveBeenCalled();
  expect(result.traffic.status).toBe('unavailable');
  expect(result.security.status).toBe('ready');
  const disabled = await readProjectOverview('project', undefined, now);
  expect([
    disabled.traffic.status,
    disabled.security.status,
    disabled.performance.status,
  ]).toEqual(['unavailable', 'unavailable', 'unavailable']);
});

const harness = createServerHarness();
afterEach(() => harness.close());
test('overview tool is app-only, read-only, and enforces connection scope without database access', async () => {
  const debugging = fixture();
  const { client } = await harness.setup({
    clientCapabilities: {
      extensions: { 'io.modelcontextprotocol/ui': {} },
    } as never,
    apps: { assets: { url: 'https://cdn.example.com/mcp-apps/v1' } },
    platform: { debugging } as SupabasePlatform,
    projectId: 'project',
    features: ['debugging'],
    readOnly: true,
  });
  const tool = (await client.listTools()).tools.find(
    (tool) => tool.name === 'app_get_project_overview'
  );
  expect(tool?._meta).toEqual({ ui: { visibility: ['app'] } });
  expect(tool?.annotations?.readOnlyHint).toBe(true);
  const denied = await client.callTool({
    name: 'app_get_project_overview',
    arguments: { project_id: 'other' },
  });
  expect(denied.isError).toBe(true);
  expect(debugging.queryLogs).not.toHaveBeenCalled();
  const allowed = await client.callTool({
    name: 'app_get_project_overview',
    arguments: { project_id: 'project' },
  });
  expect(allowed.isError).not.toBe(true);
  expect(debugging.getSecurityAdvisors).toHaveBeenCalledWith('project');
});
