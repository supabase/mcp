import { API_URL, createProjectFixture } from '../test/mocks.js';
import { createServerHarness } from '../test/server-harness.js';
import type { SupabasePlatform } from './platform/types.js';
import type { WarehouseContext } from './platform/warehouse.js';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const harness = createServerHarness();
const setup = harness.setup;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

const warehouseContext: WarehouseContext = {
  project_ref: 'abcdefghijklmnopqrst',
  observed_at: '2026-11-05T00:00:00.000Z',
  status: 'starting',
  lifecycle: null,
  compute: {
    status: 'available',
    region: 'ap-southeast-1',
    routing_status: 'pending',
    observed_at: '2026-11-05T00:00:00.000Z',
  },
  pipeline: {
    id: 'pipeline-1',
    status: 'starting',
    observed_at: '2026-11-05T00:00:00.000Z',
  },
  replication: { status: 'not_started', observed_at: null, apply_lag: null },
  tables: {
    status: 'available',
    observed_at: '2026-11-05T00:00:00.000Z',
    items: [
      {
        id: 16408,
        schema: 'public',
        name: 'orders',
        replication_state: null,
        sync_lag: null,
      },
    ],
  },
  capabilities: {
    context: true,
    workload_metrics: false,
    query_explain: false,
    table_layout_read: false,
    table_layout_update: false,
  },
};

describe('Warehouse context', () => {
  test('is opt-in and remains available in read-only, project-scoped sessions', async () => {
    const defaults = await setup();
    expect(
      (await defaults.client.listTools()).tools.map((t) => t.name)
    ).not.toContain('get_warehouse_context');
    const scoped = await setup({
      features: ['warehouse'],
      projectId: warehouseContext.project_ref,
      readOnly: true,
    });
    const { tools } = await scoped.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['get_warehouse_context']);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    expect(tools[0]?.inputSchema.properties).not.toHaveProperty('project_id');
  });

  test('uses the authenticated Platform API and cannot override the session project', async () => {
    const refs: string[] = [];
    harness.mockServer?.use(
      http.get(
        `${API_URL}/platform/warehouse/:ref/context`,
        ({ params, request }) => {
          refs.push(String(params.ref));
          expect(request.headers.get('authorization')).toMatch(/^Bearer /);
          expect(request.headers.get('user-agent')).toContain('supabase-mcp/');
          return HttpResponse.json({
            ...warehouseContext,
            credential: 'must-not-leak',
            compute: { ...warehouseContext.compute, backend: 'must-not-leak' },
          });
        }
      )
    );
    const { callTool } = await setup({
      features: ['warehouse'],
      projectId: warehouseContext.project_ref,
      readOnly: true,
    });
    await expect(
      callTool({
        name: 'get_warehouse_context',
        arguments: { project_id: 'zzzzzzzzzzzzzzzzzzzz' },
      })
    ).rejects.toThrow('project_id');
    expect(refs).toEqual([]);
    const result = await callTool({
      name: 'get_warehouse_context',
      arguments: {},
    });
    expect(refs).toEqual([warehouseContext.project_ref]);
    expect(result).toEqual(warehouseContext);
  });

  test('preserves an explicit unavailable response without inventing healthy state', async () => {
    const unavailable = {
      ...warehouseContext,
      status: 'unavailable',
      pipeline: null,
      replication: {
        status: 'unavailable',
        observed_at: null,
        apply_lag: null,
      },
      tables: { status: 'unavailable', observed_at: null, items: [] },
    };
    harness.mockServer?.use(
      http.get(`${API_URL}/platform/warehouse/:ref/context`, () =>
        HttpResponse.json(unavailable)
      )
    );
    const { callTool } = await setup({ features: ['warehouse'] });
    expect(
      await callTool({
        name: 'get_warehouse_context',
        arguments: { project_id: warehouseContext.project_ref },
      })
    ).toEqual(unavailable);
  });

  test.each([401, 403, 404, 503])(
    'propagates HTTP %s as a tool error, not an absent Warehouse',
    async (status) => {
      harness.mockServer?.use(
        http.get(`${API_URL}/platform/warehouse/:ref/context`, () =>
          HttpResponse.json(
            { message: 'Warehouse context denied or unavailable' },
            { status }
          )
        )
      );
      const { client } = await setup({ features: ['warehouse'] });
      const result = await client.callTool({
        name: 'get_warehouse_context',
        arguments: { project_id: warehouseContext.project_ref },
      });
      expect(result.isError).toBe(true);
    }
  );

  test('rejects malformed project references before making an API call', async () => {
    const { client } = await setup({ features: ['warehouse'] });
    const result = await client.callTool({
      name: 'get_warehouse_context',
      arguments: { project_id: '../another-project' },
    });
    expect(result.isError).toBe(true);
  });

  test('rejects a response for a different project', async () => {
    harness.mockServer?.use(
      http.get(`${API_URL}/platform/warehouse/:ref/context`, () =>
        HttpResponse.json({
          ...warehouseContext,
          project_ref: 'zzzzzzzzzzzzzzzzzzzz',
        })
      )
    );
    const { client } = await setup({ features: ['warehouse'] });
    expect(
      (
        await client.callTool({
          name: 'get_warehouse_context',
          arguments: { project_id: warehouseContext.project_ref },
        })
      ).isError
    ).toBe(true);
  });

  test('returns typed context over the modern HTTP transport', async () => {
    harness.mockServer?.use(
      http.get(`${API_URL}/platform/warehouse/:ref/context`, () =>
        HttpResponse.json(warehouseContext)
      )
    );
    const { client } = await harness.setupModern({
      features: ['warehouse'],
      projectId: warehouseContext.project_ref,
      readOnly: true,
    });
    const result = await client.callTool({
      name: 'get_warehouse_context',
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(warehouseContext) },
    ]);
  });
});

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

  test.each([
    [404, 'ToolCallerError', 'Project not found'],
    [429, 'Error', 'Too many requests'],
    [500, 'Error', 'Internal error'],
  ])(
    'get health advisors surfaces a %s as %s',
    async (status, name, message) => {
      const { callTool } = await setup();
      harness.mockServer!.use(
        http.post(`${API_URL}/v2/projects/:projectId/advisors/run`, () =>
          HttpResponse.json({ error: { code: 'error', message } }, { status })
        )
      );

      await expect(
        callTool({
          name: 'get_advisors',
          arguments: { project_id: 'test-project', type: 'health' },
        })
      ).rejects.toMatchObject({ name, message });
    }
  );

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
