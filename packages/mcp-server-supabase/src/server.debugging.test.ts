import { API_URL, createProjectFixture } from '../test/mocks.js';
import { createServerHarness } from '../test/server-harness.js';
import type { SupabasePlatform } from './platform/types.js';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const harness = createServerHarness();
const setup = harness.setup;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

describe('tools', () => {
  test('get logs for each service type', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const services = [
      'api',
      'branch-action',
      'postgres',
      'edge-function',
      'edge-function-runtime',
      'auth',
      'storage',
      'realtime',
    ] as const;

    for (const service of services) {
      const { result } = await callTool({
        name: 'get_logs',
        arguments: {
          project_id: project.id,
          service,
        },
      });

      expect(result).toContain('untrusted-data');
      expect(result).toContain(JSON.stringify([]));
    }
  });

  test('get logs forwards custom timestamp window', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const capturedSearchParams: URLSearchParams[] = [];

    harness.mockServer?.use(
      http.get<{ projectId: string }>(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        ({ params, request }) => {
          expect(params.projectId).toBe(project.id);
          capturedSearchParams.push(new URL(request.url).searchParams);

          return HttpResponse.json([]);
        }
      )
    );

    const isoTimestampStart = '2024-02-01T10:00:00.000Z';
    const isoTimestampEnd = '2024-02-01T11:00:00.000Z';

    const { result } = await callTool({
      name: 'get_logs',
      arguments: {
        project_id: project.id,
        service: 'edge-function-runtime',
        iso_timestamp_start: isoTimestampStart,
        iso_timestamp_end: isoTimestampEnd,
      },
    });

    expect(result).toContain('untrusted-data');
    expect(capturedSearchParams).toHaveLength(1);
    expect(capturedSearchParams[0]?.get('iso_timestamp_start')).toBe(
      isoTimestampStart
    );
    expect(capturedSearchParams[0]?.get('iso_timestamp_end')).toBe(
      isoTimestampEnd
    );
  });

  test('query logs forwards custom sql and defaults the timestamp window', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const capturedSearchParams: URLSearchParams[] = [];

    harness.mockServer?.use(
      http.get<{ projectId: string }>(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        ({ params, request }) => {
          expect(params.projectId).toBe(project.id);
          capturedSearchParams.push(new URL(request.url).searchParams);

          return HttpResponse.json([]);
        }
      )
    );

    const sql =
      "select id, timestamp, event_message from logs where source = 'postgres_logs' order by timestamp desc limit 10";

    const before = Date.now();
    const { result } = await callTool({
      name: 'query_logs',
      arguments: {
        project_id: project.id,
        sql,
      },
    });
    const after = Date.now();

    expect(result).toContain('untrusted-data');
    expect(capturedSearchParams).toHaveLength(1);
    expect(capturedSearchParams[0]?.get('sql')).toBe(sql);

    const end = capturedSearchParams[0]?.get('iso_timestamp_end');
    const start = capturedSearchParams[0]?.get('iso_timestamp_start');
    const endMs = Date.parse(end!);

    expect(endMs).toBeGreaterThanOrEqual(before);
    expect(endMs).toBeLessThanOrEqual(after);
    expect(start).toBe(new Date(endMs - 24 * 60 * 60 * 1000).toISOString());
  });

  test('query logs forwards a custom timestamp window', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const capturedSearchParams: URLSearchParams[] = [];

    harness.mockServer?.use(
      http.get<{ projectId: string }>(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        ({ request }) => {
          capturedSearchParams.push(new URL(request.url).searchParams);
          return HttpResponse.json([]);
        }
      )
    );

    const isoTimestampStart = '2024-02-01T10:00:00.000Z';
    const isoTimestampEnd = '2024-02-01T11:00:00.000Z';

    await callTool({
      name: 'query_logs',
      arguments: {
        project_id: project.id,
        sql: 'select id from logs limit 1',
        iso_timestamp_start: isoTimestampStart,
        iso_timestamp_end: isoTimestampEnd,
      },
    });

    expect(capturedSearchParams).toHaveLength(1);
    expect(capturedSearchParams[0]?.get('iso_timestamp_start')).toBe(
      isoTimestampStart
    );
    expect(capturedSearchParams[0]?.get('iso_timestamp_end')).toBe(
      isoTimestampEnd
    );
  });

  test('query logs anchors the default start to a supplied end', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const capturedSearchParams: URLSearchParams[] = [];

    harness.mockServer?.use(
      http.get<{ projectId: string }>(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        ({ request }) => {
          capturedSearchParams.push(new URL(request.url).searchParams);
          return HttpResponse.json([]);
        }
      )
    );

    const isoTimestampEnd = '2024-02-01T11:00:00.000Z';

    await callTool({
      name: 'query_logs',
      arguments: {
        project_id: project.id,
        sql: 'select id from logs limit 1',
        iso_timestamp_end: isoTimestampEnd,
      },
    });

    expect(capturedSearchParams).toHaveLength(1);
    expect(capturedSearchParams[0]?.get('iso_timestamp_end')).toBe(
      isoTimestampEnd
    );
    const expectedStart = new Date(
      new Date(isoTimestampEnd).getTime() - 24 * 60 * 60 * 1000
    ).toISOString();
    expect(capturedSearchParams[0]?.get('iso_timestamp_start')).toBe(
      expectedStart
    );
  });

  test('query logs rejects a malformed iso_timestamp_end', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await expect(
      callTool({
        name: 'query_logs',
        arguments: {
          project_id: project.id,
          sql: 'select id from logs limit 1',
          iso_timestamp_end: 'not-a-timestamp',
        },
      })
    ).rejects.toThrow(/Invalid ISO datetime/);
  });

  test('query logs rejects a start at or after the end', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await expect(
      callTool({
        name: 'query_logs',
        arguments: {
          project_id: project.id,
          sql: 'select id from logs limit 1',
          iso_timestamp_start: '2024-02-01T11:00:00.000Z',
          iso_timestamp_end: '2024-02-01T10:00:00.000Z',
        },
      })
    ).rejects.toThrow(/must be before/);

    await expect(
      callTool({
        name: 'query_logs',
        arguments: {
          project_id: project.id,
          sql: 'select id from logs limit 1',
          iso_timestamp_start: '2024-02-01T10:00:00.000Z',
          iso_timestamp_end: '2024-02-01T10:00:00.000Z',
        },
      })
    ).rejects.toThrow(/must be before/);
  });

  test('query logs rejects an empty sql query', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await expect(
      callTool({
        name: 'query_logs',
        arguments: {
          project_id: project.id,
          sql: '',
        },
      })
    ).rejects.toThrow(/too_small|at least 1 character/);
  });

  test('legacy platforms advertise and run only supported advisor types', async () => {
    const platform: SupabasePlatform = {
      debugging: {
        async getLogs() {
          return [];
        },
        async getSecurityAdvisors() {
          return { lints: [] };
        },
        async getPerformanceAdvisors() {
          return { lints: [] };
        },
      },
    };
    const { client, callTool } = await setup({
      platform,
      features: ['debugging'],
    });
    const { tools } = await client.listTools();
    const advisors = tools.find((tool) => tool.name === 'get_advisors');

    expect(advisors?.inputSchema.properties?.type).toMatchObject({
      enum: ['security', 'performance'],
    });
    for (const type of ['security', 'performance']) {
      await expect(
        callTool({
          name: 'get_advisors',
          arguments: { project_id: 'test-project', type },
        })
      ).resolves.toEqual({ result: { lints: [] } });
    }
    await expect(
      callTool({
        name: 'get_advisors',
        arguments: { project_id: 'test-project', type: 'health' },
      })
    ).rejects.toThrow();
  });

  test('get security advisors', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const { result } = await callTool({
      name: 'get_advisors',
      arguments: {
        project_id: project.id,
        type: 'security',
      },
    });

    expect(result).toEqual({ lints: [] });
  });

  test('get advisors groups repeated lints for both security and performance', async () => {
    const platform: SupabasePlatform = {
      debugging: {
        getLogs() {
          throw new Error('Not implemented');
        },
        async getSecurityAdvisors() {
          return {
            lints: [
              {
                name: 'function_search_path_mutable',
                title: 'Function Search Path Mutable',
                level: 'WARN',
                facing: 'EXTERNAL',
                categories: ['SECURITY'],
                description:
                  'Detects functions where the search_path parameter is not set.',
                detail: 'Function `public.a` has a role mutable search_path',
                remediation:
                  'https://supabase.com/docs/guides/database/database-linter',
                cache_key: 'function_search_path_mutable_public_a',
              },
              {
                name: 'function_search_path_mutable',
                title: 'Function Search Path Mutable',
                level: 'WARN',
                facing: 'EXTERNAL',
                categories: ['SECURITY'],
                description:
                  'Detects functions where the search_path parameter is not set.',
                detail: 'Function `public.b` has a role mutable search_path',
                remediation:
                  'https://supabase.com/docs/guides/database/database-linter',
                cache_key: 'function_search_path_mutable_public_b',
              },
            ],
          };
        },
        async getPerformanceAdvisors() {
          return {
            lints: [
              { name: 'unused_index', level: 'INFO', detail: 'index a' },
              { name: 'unused_index', level: 'INFO', detail: 'index b' },
            ],
          };
        },
      },
    };

    const { callTool } = await setup({ platform, features: ['debugging'] });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const { result: security } = await callTool({
      name: 'get_advisors',
      arguments: {
        project_id: project.id,
        type: 'security',
      },
    });

    expect(security).toEqual({
      lints: [
        {
          name: 'function_search_path_mutable',
          title: 'Function Search Path Mutable',
          level: 'WARN',
          facing: 'EXTERNAL',
          categories: ['SECURITY'],
          description:
            'Detects functions where the search_path parameter is not set.',
          remediation:
            'https://supabase.com/docs/guides/database/database-linter',
          count: 2,
          findings: [
            { detail: 'Function `public.a` has a role mutable search_path' },
            { detail: 'Function `public.b` has a role mutable search_path' },
          ],
        },
      ],
    });

    const { result: performance } = await callTool({
      name: 'get_advisors',
      arguments: {
        project_id: project.id,
        type: 'performance',
      },
    });

    expect(performance).toEqual({
      lints: [
        {
          name: 'unused_index',
          level: 'INFO',
          count: 2,
          findings: [{ detail: 'index a' }, { detail: 'index b' }],
        },
      ],
    });
  });

  test('get performance advisors', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const { result } = await callTool({
      name: 'get_advisors',
      arguments: {
        project_id: project.id,
        type: 'performance',
      },
    });

    expect(result).toEqual({ lints: [] });
  });

  test('get health advisors returns error-rate findings and hides unavailable statuses', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const { result } = await callTool({
      name: 'get_advisors',
      arguments: {
        project_id: project.id,
        type: 'health',
      },
    });

    expect(result).toEqual({
      lints: [
        {
          name: 'log_data_api_error_rate_high',
          title: 'Data API error rate is high',
          level: 'ERROR',
          facing: 'EXTERNAL',
          categories: ['HEALTH'],
          description: 'The Data API is returning elevated errors.',
          remediation: 'https://supabase.com/docs/guides/platform/health',
          count: 1,
          findings: [
            {
              detail: 'The Data API error rate exceeded the threshold.',
            },
          ],
        },
      ],
    });
  });

  test('get logs for invalid service type', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const invalidService = 'invalid-service';
    const getLogsPromise = callTool({
      name: 'get_logs',
      arguments: {
        project_id: project.id,
        service: invalidService,
      },
    });
    await expect(getLogsPromise).rejects.toThrow('Invalid option');
  });
});
