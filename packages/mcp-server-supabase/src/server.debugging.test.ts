import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
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
    expect(tools.some((tool) => tool.name === 'get_issues')).toBe(true);
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

test('issues defaults to all checks and reports unavailable health without losing real findings', async () => {
  const distinctLint = {
    title: 'Finding',
    description: 'Description',
    detail: 'Affected resource',
  };
  harness.mockServer?.use(
    http.get(`${API_URL}/v1/projects/:projectId/advisors/security`, () =>
      HttpResponse.json({
        lints: [{ ...distinctLint, name: 'security_finding', level: 'WARN' }],
      })
    ),
    http.get(`${API_URL}/v1/projects/:projectId/advisors/performance`, () =>
      HttpResponse.json({
        lints: [
          { ...distinctLint, name: 'performance_finding', level: 'INFO' },
        ],
      })
    )
  );
  const { project } = await createProjectFixture();
  const { client, callTool } = await setup({
    projectId: project.id,
    readOnly: true,
  });
  const { tools } = await client.listTools();
  const tool = tools.find(({ name }) => name === 'get_issues');
  expect(tool?.inputSchema.properties).not.toHaveProperty('project_id');
  expect(tools.some(({ name }) => name === 'get_advisors')).toBe(true);
  const result = await callTool({ name: 'get_issues', arguments: {} });
  expect(result.checks).toMatchObject([
    { type: 'security', status: 'complete' },
    { type: 'performance', status: 'complete' },
    {
      type: 'health',
      status: 'unavailable',
      reason: expect.stringContaining('advisor_check_unavailable'),
    },
  ]);
  expect(result.issues).toMatchObject([
    {
      id: 'log_data_api_error_rate_high',
      severity: 'critical',
      category: 'health',
    },
    { id: 'security_finding', category: 'security', severity: 'warning' },
    { id: 'performance_finding', category: 'performance', severity: 'info' },
  ]);
});

test('issues distinguishes unsupported health from completed checks on legacy platforms', async () => {
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
  expect(
    tools.find(({ name }) => name === 'get_issues')?.inputSchema.properties
      ?.type
  ).toMatchObject({ enum: ['all', 'security', 'performance'] });
  expect(
    await callTool({ name: 'get_issues', arguments: { project_id: 'legacy' } })
  ).toEqual({
    issues: [],
    checks: [
      { type: 'security', status: 'complete' },
      { type: 'performance', status: 'complete' },
      {
        type: 'health',
        status: 'unavailable',
        reason: 'Health issues are not supported by this platform',
      },
    ],
  });
  await expect(
    callTool({
      name: 'get_issues',
      arguments: { project_id: 'legacy', type: 'health' },
    })
  ).rejects.toThrow('Invalid option');
});

test.each([401, 403])(
  'issues propagates API authorization failure %s instead of presenting clean checks',
  async (status) => {
    const { project } = await createProjectFixture();
    const { callTool } = await setup();
    harness.mockServer?.use(
      http.get(`${API_URL}/v1/projects/:projectId/advisors/security`, () =>
        HttpResponse.json({ message: 'Access denied' }, { status })
      )
    );
    await expect(
      callTool({ name: 'get_issues', arguments: { project_id: project.id } })
    ).rejects.toThrow(status === 401 ? 'Unauthorized' : 'Access denied');
  }
);

test('explicit issue filters only run the requested check and retain lower severity evidence', async () => {
  const { project } = await createProjectFixture();
  const { callTool } = await setup();
  const called: string[] = [];
  const finding = {
    name: 'mixed_severity',
    title: 'Mixed severity',
    description: 'Mixed finding levels',
    detail: 'Affected resource',
    remediation: 'https://example.com/fix',
  };
  harness.mockServer?.use(
    http.get(`${API_URL}/v1/projects/:projectId/advisors/security`, () => {
      called.push('security');
      return HttpResponse.json({
        lints: [
          { ...finding, level: 'INFO', cache_key: 'low' },
          { ...finding, level: 'ERROR', cache_key: 'high' },
          { ...finding, name: 'info_only', level: 'INFO', cache_key: 'other' },
        ],
      });
    }),
    http.get(`${API_URL}/v1/projects/:projectId/advisors/performance`, () => {
      called.push('performance');
      return HttpResponse.json({ lints: [] });
    }),
    http.post(`${API_URL}/v2/projects/:projectId/advisors/run`, () => {
      called.push('health');
      return HttpResponse.json({});
    })
  );
  const result = await callTool({
    name: 'get_issues',
    arguments: {
      project_id: project.id,
      type: 'security',
      severity: 'critical',
    },
  });
  expect(called).toEqual(['security']);
  expect(result.checks).toEqual([{ type: 'security', status: 'complete' }]);
  expect(result.issues).toMatchObject([
    {
      id: 'mixed_severity',
      severity: 'critical',
      category: 'security',
      affected_count: 2,
      affected: [
        { id: 'high', severity: 'critical' },
        { id: 'low', severity: 'info' },
      ],
    },
  ]);
  expect(result.issues).toHaveLength(1);
});

// Fixture response is 43,493 chars; the budget fails growth of over ~10%.
// In #124, Claude Code rejected a tool response over 25,000 tokens.
const LARGE_PROJECT_ISSUES_BUDGET = 48_000;

test('issues stay within the response budget for a large project', async () => {
  const largeProject = [
    ['auth_rls_initplan', 'WARN', 'PERFORMANCE', 160],
    ['unindexed_foreign_keys', 'INFO', 'PERFORMANCE', 160],
    ['function_search_path_mutable', 'WARN', 'SECURITY', 81],
    ['multiple_permissive_policies', 'WARN', 'PERFORMANCE', 80],
    ['rls_enabled_no_policy', 'INFO', 'SECURITY', 30],
    ['duplicate_index', 'WARN', 'PERFORMANCE', 20],
    ['no_primary_key', 'INFO', 'PERFORMANCE', 10],
    ['materialized_view_in_api', 'WARN', 'SECURITY', 3],
    ['policy_exists_rls_disabled', 'ERROR', 'SECURITY', 1],
    ['rls_disabled_in_public', 'ERROR', 'SECURITY', 1],
    ['security_definer_view', 'ERROR', 'SECURITY', 1],
  ] as const;
  const lints = (category: 'SECURITY' | 'PERFORMANCE') => ({
    lints: largeProject
      .filter((lint) => lint[2] === category)
      .flatMap(([name, level, , count]) =>
        Array.from({ length: count }, (_, i) => ({
          name,
          title: name.replaceAll('_', ' '),
          level,
          categories: [category],
          description: `Detects ${name.replaceAll('_', ' ')} in the exposed schemas, which can affect the security or performance of the project.`,
          detail: `Table \\\`public.table_${i}\\\` is affected by ${name}. This can lead to suboptimal query performance or expose data through the Data API.`,
          remediation: `https://supabase.com/docs/guides/database/database-linter?lint=${name}`,
          cache_key: `${name}_public_table_${i}`,
          metadata: { name: `table_${i}`, type: 'table', schema: 'public' },
        }))
      ),
  });
  const platform: SupabasePlatform = {
    debugging: {
      async getLogs() {
        return [];
      },
      async getSecurityAdvisors() {
        return lints('SECURITY');
      },
      async getPerformanceAdvisors() {
        return lints('PERFORMANCE');
      },
      async getHealthAdvisors() {
        return { lints: [] };
      },
    },
  };
  const { client } = await setup({ platform, features: ['debugging'] });
  const result = await client.callTool({
    name: 'get_issues',
    arguments: { project_id: 'large' },
  });
  const [content] = result.content as { type: 'text'; text: string }[];
  const { issues } = JSON.parse(content!.text);
  expect(issues).toHaveLength(11);
  expect(
    issues.reduce(
      (total: number, issue: { affected_count: number }) =>
        total + issue.affected_count,
      0
    )
  ).toBe(547);
  expect(content!.text.length).toBeLessThan(LARGE_PROJECT_ISSUES_BUDGET);
});

test.each(['security', 'performance'] as const)(
  'issues requests unavailable %s results without changing legacy advisors',
  async (type) => {
    const getAdvisors = async (
      _projectId: string,
      options?: { includeUnavailable?: boolean }
    ) => ({
      lints: options?.includeUnavailable
        ? [
            {
              name: 'project_not_active',
              title: 'Project is not active',
              description: 'The project is inactive.',
              detail: 'The project is inactive.',
              level: 'ERROR',
            },
          ]
        : [],
    });
    const platform: SupabasePlatform = {
      debugging: {
        async getLogs() {
          return [];
        },
        getSecurityAdvisors: getAdvisors,
        getPerformanceAdvisors: getAdvisors,
      },
    };
    const { callTool } = await setup({ platform, features: ['debugging'] });
    expect(
      await callTool({
        name: 'get_issues',
        arguments: { project_id: 'inactive', type },
      })
    ).toEqual({
      issues: [],
      checks: [
        {
          type,
          status: 'unavailable',
          reason: expect.stringContaining('project_not_active'),
        },
      ],
    });
    expect(
      await callTool({
        name: 'get_advisors',
        arguments: { project_id: 'inactive', type },
      })
    ).toEqual({ result: { lints: [] } });
  }
);

test.each([500, 429])(
  'issues preserve security findings when health fails with %s',
  async (status) => {
    const { project } = await createProjectFixture();
    const { callTool } = await setup();
    harness.mockServer?.use(
      http.get(`${API_URL}/v1/projects/:projectId/advisors/security`, () =>
        HttpResponse.json({
          lints: [
            {
              name: 'critical_security',
              title: 'Critical security',
              description: 'Description',
              detail: 'Resource',
              level: 'ERROR',
            },
          ],
        })
      ),
      http.post(`${API_URL}/v2/projects/:projectId/advisors/run`, () =>
        HttpResponse.json(
          { error: { message: 'Health unavailable' } },
          { status }
        )
      )
    );
    const result = await callTool({
      name: 'get_issues',
      arguments: { project_id: project.id },
    });
    expect(result.issues).toMatchObject([
      { id: 'critical_security', category: 'security' },
    ]);
    expect(result.checks).toEqual([
      { type: 'security', status: 'complete' },
      { type: 'performance', status: 'complete' },
      { type: 'health', status: 'unavailable', reason: 'Health unavailable' },
    ]);
  }
);

test.each([401, 403])(
  'issues propagate health authorization failure %s',
  async (status) => {
    const { project } = await createProjectFixture();
    const { callTool } = await setup();
    harness.mockServer?.use(
      http.post(`${API_URL}/v2/projects/:projectId/advisors/run`, () =>
        HttpResponse.json({ error: { message: 'Access denied' } }, { status })
      )
    );
    await expect(
      callTool({ name: 'get_issues', arguments: { project_id: project.id } })
    ).rejects.toThrow(status === 401 ? 'Unauthorized' : 'Access denied');
  }
);

test.each([
  new ProtocolError(
    ProtocolErrorCode.InvalidRequest,
    'OAuth permission denied'
  ),
  Object.assign(new Error('FGA permission denied'), { statusCode: 403 }),
  Object.assign(new Error('Permission denied'), { response: { status: 401 } }),
])('issues preserve platform authorization errors: %s', async (error) => {
  const platform: SupabasePlatform = {
    debugging: {
      async getLogs() {
        return [];
      },
      async getSecurityAdvisors() {
        throw error;
      },
      async getPerformanceAdvisors() {
        return { lints: [] };
      },
    },
  };
  const { callTool } = await setup({ platform, features: ['debugging'] });
  await expect(
    callTool({ name: 'get_issues', arguments: { project_id: 'denied' } })
  ).rejects.toThrow(error.message.replace(/^MCP error [^:]+: /, ''));
});

test('issues keep self-hosted findings when another adapter times out or returns malformed data', async () => {
  const lints = [
    {
      name: 'security_finding',
      title: 'Security finding',
      description: 'Description',
      detail: 'Resource',
      level: 'ERROR',
    },
  ];
  const platform: SupabasePlatform = {
    debugging: {
      async getLogs() {
        return [];
      },
      async getSecurityAdvisors() {
        return lints;
      },
      async getPerformanceAdvisors() {
        return { lints: null };
      },
      async getHealthAdvisors() {
        throw new Error('Health check timed out');
      },
    },
  };
  const { callTool } = await setup({ platform, features: ['debugging'] });
  const result = await callTool({
    name: 'get_issues',
    arguments: { project_id: 'self-hosted' },
  });
  expect(result.issues).toMatchObject([
    { id: 'security_finding', category: 'security', affected_count: 1 },
  ]);
  expect(result.checks).toMatchObject([
    { type: 'security', status: 'complete' },
    { type: 'performance', status: 'unavailable', reason: expect.any(String) },
    { type: 'health', status: 'unavailable', reason: 'Health check timed out' },
  ]);
  expect(
    await callTool({
      name: 'get_advisors',
      arguments: { project_id: 'self-hosted', type: 'security' },
    })
  ).toEqual({ result: lints });
});
