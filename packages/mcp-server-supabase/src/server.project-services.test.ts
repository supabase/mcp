import { codeBlock } from 'common-tags';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  API_URL,
  createOrganization,
  createProject,
  createProjectFixture,
} from '../test/mocks.js';
import { createServerHarness } from '../test/server-harness.js';
import type { SupabasePlatform } from './platform/types.js';

const harness = createServerHarness();
const setup = harness.setup;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

describe('tools', () => {
  test('list storage buckets', async () => {
    const { callTool } = await setup({ features: ['storage'] });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    project.createStorageBucket('bucket1', true);
    project.createStorageBucket('bucket2', false);

    const result = await callTool({
      name: 'list_storage_buckets',
      arguments: {
        project_id: project.id,
      },
    });

    expect(Array.isArray(result.buckets)).toBe(true);
    expect(result.buckets.length).toBe(2);
    expect(result.buckets[0]).toEqual(
      expect.objectContaining({
        name: 'bucket1',
        public: true,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
    expect(result.buckets[1]).toEqual(
      expect.objectContaining({
        name: 'bucket2',
        public: false,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
  });

  test('get storage config', async () => {
    const { callTool } = await setup({ features: ['storage'] });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const result = await callTool({
      name: 'get_storage_config',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result).toEqual({
      fileSizeLimit: expect.any(Number),
      features: {
        imageTransformation: { enabled: expect.any(Boolean) },
        s3Protocol: { enabled: expect.any(Boolean) },
      },
    });
  });

  test('update storage config', async () => {
    const { callTool } = await setup({ features: ['storage'] });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const config = {
      fileSizeLimit: 50,
      features: {
        imageTransformation: { enabled: true },
        s3Protocol: { enabled: false },
      },
    };

    const result = await callTool({
      name: 'update_storage_config',
      arguments: {
        project_id: project.id,
        config,
      },
    });

    expect(result).toEqual({ success: true });
  });

  test('update storage config in read-only mode throws an error', async () => {
    const { callTool } = await setup({ readOnly: true, features: ['storage'] });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const config = {
      fileSizeLimit: 50,
      features: {
        imageTransformation: { enabled: true },
        s3Protocol: { enabled: false },
      },
    };

    const result = callTool({
      name: 'update_storage_config',
      arguments: {
        project_id: project.id,
        config,
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot update storage config in read-only mode.'
    );
  });

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

  test('list edge functions', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const indexContent = codeBlock`
      Deno.serve(async (req: Request) => {
        return new Response('Hello world!', { headers: { 'Content-Type': 'text/plain' } })
      });
    `;

    const edgeFunction = await project.deployEdgeFunction(
      {
        name: 'hello-world',
        entrypoint_path: 'index.ts',
      },
      [
        new File([indexContent], 'index.ts', {
          type: 'application/typescript',
        }),
      ]
    );

    const result = await callTool({
      name: 'list_edge_functions',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result.functions).toEqual([
      {
        id: edgeFunction.id,
        slug: edgeFunction.slug,
        version: edgeFunction.version,
        name: edgeFunction.name,
        status: edgeFunction.status,
        entrypoint_path: 'index.ts',
        import_map: false,
        verify_jwt: true,
        created_at: expect.any(Number),
        updated_at: expect.any(Number),
      },
    ]);
  });

  test('get edge function', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const indexContent = codeBlock`
      Deno.serve(async (req: Request) => {
        return new Response('Hello world!', { headers: { 'Content-Type': 'text/plain' } })
      });
    `;

    const edgeFunction = await project.deployEdgeFunction(
      {
        name: 'hello-world',
        entrypoint_path: 'index.ts',
      },
      [
        new File([indexContent], 'index.ts', {
          type: 'application/typescript',
        }),
      ]
    );

    const result = await callTool({
      name: 'get_edge_function',
      arguments: {
        project_id: project.id,
        function_slug: edgeFunction.slug,
      },
    });

    expect(result).toEqual({
      id: edgeFunction.id,
      slug: edgeFunction.slug,
      version: edgeFunction.version,
      name: edgeFunction.name,
      status: edgeFunction.status,
      entrypoint_path: 'index.ts',
      import_map: false,
      verify_jwt: true,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
      files: [
        {
          name: 'index.ts',
          content: indexContent,
        },
      ],
    });
  });

  test('deploy new edge function', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const functionName = 'hello-world';
    const functionCode = 'console.log("Hello, world!");';

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
        ],
      },
    });

    expect(result).toEqual({
      id: expect.stringMatching(/^.+$/),
      slug: functionName,
      version: 1,
      name: functionName,
      status: 'ACTIVE',
      entrypoint_path: expect.stringMatching(/index\.ts$/),
      import_map: false,
      verify_jwt: true,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });
  });

  test('deploy edge function in read-only mode throws an error', async () => {
    const { callTool } = await setup({ readOnly: true });

    const { project } = await createProjectFixture({
      organization: { name: 'test-org', allowed_release_channels: ['ga'] },
      project: { name: 'test-app', region: 'us-east-1' },
    });

    const functionName = 'hello-world';
    const functionCode = 'console.log("Hello, world!");';

    const result = callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
        ],
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot deploy an edge function in read-only mode.'
    );
  });

  test('deploy edge function validates slug format', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'test-org', allowed_release_channels: ['ga'] },
      project: { name: 'test-app', region: 'us-east-1' },
    });

    const functionInvalidSlugs = [
      // Leading character violations
      '[DEPRECATED] hello-world', // leading bracket
      '_hello-world', // leading underscore
      '-hello-world', // leading hyphen
      '0hello-world', // leading digit
      '#hello-world', // leading special char
      '.hello-world', // leading dot

      // Trailing character violations
      'hello-world ', // trailing space
      'hello-world.', // trailing dot
      'hello-world#', // trailing hash
      'hello-world!', // trailing exclamation
      'hello-world@', // trailing at sign
      'hello-world[', // trailing bracket

      // Whitespace
      'hello world', // space
      'hello\tworld', // tab
      'hello\nworld', // newline
      ' hello-world', // leading space

      // Special characters in body
      'hello.world', // dot
      'hello@world', // at sign
      'hello/world', // slash
      'hello\\world', // backslash
      'hello$world', // dollar sign
      'hello!world', // exclamation

      // Edge cases
      '', // empty string
      ' ', // only space
      '-', // only hyphen
      '_', // only underscore
    ];

    const functionCode = 'console.log("Hello, world!");';

    await Promise.all(
      functionInvalidSlugs.map(async (slug) => {
        const result = callTool({
          name: 'deploy_edge_function',
          arguments: {
            project_id: project.id,
            name: slug,
            files: [
              {
                name: 'index.ts',
                content: functionCode,
              },
            ],
          },
        });
        await expect(result).rejects.toThrow(
          'Invalid string: must match pattern'
        );
      })
    );
  });

  test('deploy new version of existing edge function', async () => {
    const { callTool } = await setup();
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const functionName = 'hello-world';

    const edgeFunction = await project.deployEdgeFunction(
      {
        name: functionName,
        entrypoint_path: 'index.ts',
      },
      [
        new File(['console.log("Hello, world!");'], 'index.ts', {
          type: 'application/typescript',
        }),
      ]
    );

    expect(edgeFunction.version).toEqual(1);

    const originalCreatedAt = edgeFunction.created_at.getTime();
    const originalUpdatedAt = edgeFunction.updated_at.getTime();

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: 'console.log("Hello, world! v2");',
          },
        ],
      },
    });

    expect(result).toEqual({
      id: edgeFunction.id,
      slug: functionName,
      version: 2,
      name: functionName,
      status: 'ACTIVE',
      entrypoint_path: expect.stringMatching(/index\.ts$/),
      import_map: false,
      verify_jwt: true,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });

    expect(result.created_at).toEqual(originalCreatedAt);
    expect(result.updated_at).toBeGreaterThan(originalUpdatedAt);
  });

  test('custom edge function import map', async () => {
    const { callTool } = await setup();

    const org = await createOrganization({
      name: 'My Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const project = await createProject({
      name: 'Project 1',
      region: 'us-east-1',
      organization_id: org.id,
    });

    const functionName = 'hello-world';
    const functionCode = 'console.log("Hello, world!");';

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        import_map_path: 'custom-map.json',
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
          {
            name: 'custom-map.json',
            content: '{}',
          },
        ],
      },
    });

    expect(result.import_map).toBe(true);
    expect(result.import_map_path).toMatch(/custom-map\.json$/);
  });

  test('default edge function import map to deno.json', async () => {
    const { callTool } = await setup();

    const org = await createOrganization({
      name: 'My Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const project = await createProject({
      name: 'Project 1',
      region: 'us-east-1',
      organization_id: org.id,
    });

    const functionName = 'hello-world';
    const functionCode = 'console.log("Hello, world!");';

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
          {
            name: 'deno.json',
            content: '{}',
          },
        ],
      },
    });

    expect(result.import_map).toBe(true);
    expect(result.import_map_path).toMatch(/deno\.json$/);
  });

  test('default edge function import map to import_map.json', async () => {
    const { callTool } = await setup();

    const org = await createOrganization({
      name: 'My Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const project = await createProject({
      name: 'Project 1',
      region: 'us-east-1',
      organization_id: org.id,
    });

    const functionName = 'hello-world';
    const functionCode = 'console.log("Hello, world!");';

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
          {
            name: 'import_map.json',
            content: '{}',
          },
        ],
      },
    });

    expect(result.import_map).toBe(true);
    expect(result.import_map_path).toMatch(/import_map\.json$/);
  });

  test('updating edge function with missing import_map_path defaults to previous value', async () => {
    const { callTool } = await setup();
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const functionName = 'hello-world';

    const edgeFunction = await project.deployEdgeFunction(
      {
        name: functionName,
        entrypoint_path: 'index.ts',
        import_map_path: 'custom-map.json',
      },
      [
        new File(['console.log("Hello, world!");'], 'index.ts', {
          type: 'application/typescript',
        }),
        new File(['{}'], 'custom-map.json', {
          type: 'application/json',
        }),
      ]
    );

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: 'console.log("Hello, world! v2");',
          },
          {
            name: 'custom-map.json',
            content: '{}',
          },
        ],
      },
    });

    expect(result.import_map).toBe(true);
    expect(result.import_map_path).toMatch(/custom-map\.json$/);
  });

  test('deploy edge function with verify_jwt disabled', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const functionName = 'webhook-handler';
    const functionCode = 'console.log("Webhook handler");';

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        verify_jwt: false,
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
        ],
      },
    });

    expect(result).toEqual({
      id: expect.stringMatching(/^.+$/),
      slug: functionName,
      version: 1,
      name: functionName,
      status: 'ACTIVE',
      entrypoint_path: expect.stringMatching(/index\.ts$/),
      import_map: false,
      verify_jwt: false,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });
  });

  test('deploy edge function with verify_jwt enabled (default)', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const functionName = 'authenticated-function';
    const functionCode = 'console.log("Authenticated function");';

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
        ],
      },
    });

    expect(result.verify_jwt).toBe(true);
  });

  test('update edge function verify_jwt from true to false', async () => {
    const { callTool } = await setup();
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const functionName = 'my-function';

    // First deploy with verify_jwt: true (default)
    const edgeFunction = await project.deployEdgeFunction(
      {
        name: functionName,
        entrypoint_path: 'index.ts',
        verify_jwt: true,
      },
      [
        new File(['console.log("v1");'], 'index.ts', {
          type: 'application/typescript',
        }),
      ]
    );

    expect(edgeFunction.verify_jwt).toBe(true);

    // Update with verify_jwt: false
    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        verify_jwt: false,
        files: [
          {
            name: 'index.ts',
            content: 'console.log("v2");',
          },
        ],
      },
    });

    expect(result.verify_jwt).toBe(false);
    expect(result.version).toBe(2);
  });
});
