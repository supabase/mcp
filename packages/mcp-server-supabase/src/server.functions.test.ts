import {
  ACCESS_TOKEN,
  API_URL,
  createOrganization,
  createProject,
  createProjectFixture,
  mockSecrets,
} from '../test/mocks.js';
import { callModernTool, createServerHarness } from '../test/server-harness.js';
import { createSupabaseApiPlatform } from './platform/api-platform.js';
import { createSupabaseMcpServer } from './server.js';
import type { SupabaseMcpServerOptions } from './server.js';
import { isInputRequiredResult } from '@modelcontextprotocol/client';
import type {
  CallToolResult,
  ClientCapabilities,
  InputRequiredResult,
} from '@modelcontextprotocol/client';
import { codeBlock } from 'common-tags';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = createServerHarness();
const setup = harness.setup;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

const setupModern = harness.setupModern;

const ELICITATION_REQUEST_STATE: NonNullable<
  SupabaseMcpServerOptions['elicitation']
>['requestState'] = {
  key: 'a'.repeat(32),
  principal: 'test-user',
};

const COST_CONFIRMATION: NonNullable<
  NonNullable<SupabaseMcpServerOptions['elicitation']>['confirmation']
> = {
  enabledTools: [
    'create_project',
    'create_branch',
    'execute_sql',
    'apply_migration',
  ],
};

const FORM_CAPABLE: ClientCapabilities = { elicitation: { form: {} } };

const URL_CAPABLE: ClientCapabilities = { elicitation: { url: {} } };

const SECRET_COLLECTION: NonNullable<
  NonNullable<SupabaseMcpServerOptions['elicitation']>['secretCollection']
> = {
  connectUrlTemplate:
    'https://supabase.com/dashboard/mcp/secrets?ref={ref}&name={name}',
};

/**
 * Sets up an MCP client with URL elicitation capability for the
 * `create_edge_function_secret` secret-collection elicitation lane.
 */
const setupUrlCapable = (options: Parameters<typeof setupModern>[0] = {}) =>
  setupModern({
    ...options,
    clientCapabilities: URL_CAPABLE,
    secretCollection: SECRET_COLLECTION,
  });

describe('tools', () => {
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

  test('list edge functions with non-URL paths', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const edgeFunction = await project.deployEdgeFunction(
      {
        name: 'hello-world',
        entrypoint_path: 'index.ts',
        import_map_path: 'deno.json',
      },
      [
        new File(['Deno.serve(() => new Response("ok"))'], 'index.ts', {
          type: 'application/typescript',
        }),
        new File(['{}'], 'deno.json', { type: 'application/json' }),
      ]
    );
    edgeFunction.entrypoint_path = 'source/index.ts';
    edgeFunction.import_map_path = 'deno.json';

    const result = await callTool({
      name: 'list_edge_functions',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result.functions).toEqual([
      expect.objectContaining({
        slug: edgeFunction.slug,
        entrypoint_path: 'index.ts',
        import_map_path: 'deno.json',
      }),
    ]);
  });

  test('get edge function with non-URL paths', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const edgeFunction = await project.deployEdgeFunction(
      {
        name: 'hello-world',
        entrypoint_path: 'index.ts',
        import_map_path: 'deno.json',
      },
      [
        new File(['Deno.serve(() => new Response("ok"))'], 'index.ts', {
          type: 'application/typescript',
        }),
        new File(['{}'], 'deno.json', { type: 'application/json' }),
      ]
    );
    edgeFunction.entrypoint_path = 'supabase/functions/hello-world/index.ts';
    edgeFunction.import_map_path = 'source/deno.json';

    const result = await callTool({
      name: 'get_edge_function',
      arguments: {
        project_id: project.id,
        function_slug: edgeFunction.slug,
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        slug: edgeFunction.slug,
        entrypoint_path: 'supabase/functions/hello-world/index.ts',
        import_map_path: 'deno.json',
      })
    );
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
  describe('create_edge_function_secret via URL elicitation', () => {
    test('url-capable client receives InputRequiredResult with url mode', async () => {
      const { client } = await setupUrlCapable();

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
      project.status = 'ACTIVE_HEALTHY';

      const result = (await callModernTool(client, {
        name: 'create_edge_function_secret',
        arguments: { project_id: project.id, name: ' MY KEY&x ' },
      })) as CallToolResult | InputRequiredResult;

      expect(isInputRequiredResult(result)).toBe(true);
      if (isInputRequiredResult(result)) {
        expect(result.inputRequests?.store_secret).toMatchObject({
          method: 'elicitation/create',
          params: {
            mode: 'url',
            url: `https://supabase.com/dashboard/mcp/secrets?ref=${encodeURIComponent(project.id)}&name=${encodeURIComponent(' MY KEY&x ')}`,
          },
        });
      }
    });

    test('form-only and empty-capability clients receive isError with no URL', async () => {
      const clientCapabilities: ClientCapabilities[] = [
        { elicitation: { form: {} } },
        { elicitation: {} },
      ];
      for (const capabilities of clientCapabilities) {
        const { client } = await setupModern({
          clientCapabilities: capabilities,
          secretCollection: SECRET_COLLECTION,
        });

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
        project.status = 'ACTIVE_HEALTHY';

        const result = await client.callTool({
          name: 'create_edge_function_secret',
          arguments: { project_id: project.id, name: 'MY_SECRET' },
        });

        expect(result.isError).toBe(true);
        const textContent = result.content.find((c: any) => c.type === 'text');
        expect((textContent as any)?.text).toContain(
          'This client cannot open a browser page'
        );
        expect(JSON.stringify(result)).not.toContain('http');
      }
    });

    test('tool input schema exposes project_id, name and replace, never value', async () => {
      const { client } = await setupUrlCapable();

      const { tools } = await client.listTools();
      const secretTool = tools.find(
        (tool) => tool.name === 'create_edge_function_secret'
      );

      expect(
        Object.keys(secretTool?.inputSchema.properties ?? {}).sort()
      ).toEqual(['name', 'project_id', 'replace']);
    });

    test('name starting with SUPABASE_ is rejected', async () => {
      const { client } = await setupUrlCapable();

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
      project.status = 'ACTIVE_HEALTHY';

      const result = await client.callTool({
        name: 'create_edge_function_secret',
        arguments: { project_id: project.id, name: 'SUPABASE_URL' },
      });

      expect(result.isError).toBe(true);
    });

    test('accept with recent secret returns stored true', async () => {
      const { client } = await setupUrlCapable();

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
      project.status = 'ACTIVE_HEALTHY';

      const first = (await callModernTool(client, {
        name: 'create_edge_function_secret',
        arguments: { project_id: project.id, name: 'MY_SECRET' },
      })) as CallToolResult | InputRequiredResult;

      expect(isInputRequiredResult(first)).toBe(true);
      if (!isInputRequiredResult(first)) {
        throw new Error('expected InputRequiredResult');
      }

      // Simulate the secret being stored
      mockSecrets.set(project.id, [
        {
          name: 'MY_SECRET',
          value: 'secret-value',
          updated_at: new Date().toISOString(),
        },
      ]);

      const second = (await callModernTool(client, {
        name: 'create_edge_function_secret',
        arguments: { project_id: project.id, name: 'MY_SECRET' },
        inputResponses: {
          store_secret: { action: 'accept', content: {} },
        },
        requestState: first.requestState,
      })) as CallToolResult;

      const textContent = second.content.find((c: any) => c.type === 'text');
      expect((textContent as any)?.text).toContain(
        'The dashboard reports an update to MY_SECRET since this request'
      );
      expect((second as any).structuredContent?.stored).toBe(true);
    });

    test.each(['project_id', 'name'] as const)(
      'rejects a signed secret continuation when only %s changes',
      async (changedField) => {
        const { client } = await setupUrlCapable();
        const clock = vi
          .spyOn(Date, 'now')
          .mockReturnValue(Date.parse('2030-01-01T00:00:00Z'));
        try {
          const project = await createActiveProject();
          const args = { project_id: project.id, name: 'MY_SECRET' };
          const first = await callModernTool(client, {
            name: 'create_edge_function_secret',
            arguments: args,
          });
          if (!isInputRequiredResult(first)) {
            throw new Error('expected InputRequiredResult');
          }

          const changedArgs = {
            ...args,
            ...(changedField === 'project_id'
              ? { project_id: (await createActiveProject()).id }
              : { name: 'OTHER_SECRET' }),
          };
          // The alternate target qualifies as stored if its signed binding
          // is not checked before accepting the continuation.
          mockSecrets.set(changedArgs.project_id, [
            {
              name: changedArgs.name,
              value: 'secret-value',
              updated_at: '2030-01-01T00:00:00Z',
            },
          ]);

          const second = await callModernTool(client, {
            name: 'create_edge_function_secret',
            arguments: changedArgs,
            inputResponses: {
              store_secret: { action: 'accept', content: {} },
            },
            requestState: first.requestState,
          });
          expect(isInputRequiredResult(second)).toBe(false);
          if (isInputRequiredResult(second)) {
            throw new Error('expected CallToolResult, not InputRequiredResult');
          }
          expect(second.isError).toBe(true);
          expect(second.structuredContent ?? {}).not.toHaveProperty(
            'stored',
            true
          );
        } finally {
          clock.mockRestore();
          await client.close();
        }
      }
    );

    test('accept with old or missing secret reissues elicitation with same issued_at', async () => {
      const { client } = await setupUrlCapable();

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
      project.status = 'ACTIVE_HEALTHY';

      const first = (await callModernTool(client, {
        name: 'create_edge_function_secret',
        arguments: { project_id: project.id, name: 'MY_SECRET' },
      })) as CallToolResult | InputRequiredResult;

      expect(isInputRequiredResult(first)).toBe(true);
      if (!isInputRequiredResult(first)) {
        throw new Error('expected InputRequiredResult');
      }

      // Simulate an old secret
      const oldDate = new Date(Date.now() - 700_000);
      mockSecrets.set(project.id, [
        {
          name: 'MY_SECRET',
          value: 'secret-value',
          updated_at: oldDate.toISOString(),
        },
      ]);

      const second = (await callModernTool(client, {
        name: 'create_edge_function_secret',
        arguments: { project_id: project.id, name: 'MY_SECRET' },
        inputResponses: {
          store_secret: { action: 'accept', content: {} },
        },
        requestState: first.requestState,
      })) as CallToolResult | InputRequiredResult;

      expect(isInputRequiredResult(second)).toBe(true);
      if (isInputRequiredResult(second)) {
        expect(second.inputRequests?.store_secret).toMatchObject({
          method: 'elicitation/create',
          params: {
            url: `https://supabase.com/dashboard/mcp/secrets?ref=${encodeURIComponent(project.id)}&name=MY_SECRET`,
          },
        });

        const firstState = JSON.parse(
          Buffer.from(first.requestState!.split('.')[1]!, 'base64').toString()
        );
        const secondState = JSON.parse(
          Buffer.from(second.requestState!.split('.')[1]!, 'base64').toString()
        );
        expect(typeof firstState.p.issued_at).toBe('number');
        expect(secondState.p.issued_at).toBe(firstState.p.issued_at);
      }
    });

    test('accept with secret updated at exact issue time (second boundary)', async () => {
      const { client } = await setupUrlCapable();

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
      project.status = 'ACTIVE_HEALTHY';

      const first = (await callModernTool(client, {
        name: 'create_edge_function_secret',
        arguments: { project_id: project.id, name: 'MY_SECRET' },
      })) as CallToolResult | InputRequiredResult;

      expect(isInputRequiredResult(first)).toBe(true);
      if (!isInputRequiredResult(first)) {
        throw new Error('expected InputRequiredResult');
      }

      // Decode issued_at and set mock secret's updated_at to the same value truncated to seconds
      const firstState = JSON.parse(
        Buffer.from(first.requestState!.split('.')[1]!, 'base64').toString()
      );
      expect(firstState.p.issued_at % 1000).toBe(0);
      const issuedAtTruncated = new Date(
        Math.floor(firstState.p.issued_at / 1000) * 1000
      );
      mockSecrets.set(project.id, [
        {
          name: 'MY_SECRET',
          value: 'secret-value',
          updated_at: issuedAtTruncated.toISOString(),
        },
      ]);

      const result = (await callModernTool(client, {
        name: 'create_edge_function_secret',
        arguments: { project_id: project.id, name: 'MY_SECRET' },
        inputResponses: {
          store_secret: { action: 'accept', content: {} },
        },
        requestState: first.requestState,
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content).toMatchObject([
        {
          type: 'text',
          text: `The dashboard reports an update to MY_SECRET since this request.`,
        },
      ]);
      expect((result as any).structuredContent).toMatchObject({
        name: 'MY_SECRET',
        stored: true,
      });
    });

    test('decline and cancel return status without stored', async () => {
      const { client } = await setupUrlCapable();

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
      project.status = 'ACTIVE_HEALTHY';

      for (const action of ['decline', 'cancel'] as const) {
        const first = (await callModernTool(client, {
          name: 'create_edge_function_secret',
          arguments: { project_id: project.id, name: 'MY_SECRET' },
        })) as CallToolResult | InputRequiredResult;

        expect(isInputRequiredResult(first)).toBe(true);
        if (!isInputRequiredResult(first)) {
          throw new Error('expected InputRequiredResult');
        }

        const second = (await callModernTool(client, {
          name: 'create_edge_function_secret',
          arguments: { project_id: project.id, name: 'MY_SECRET' },
          inputResponses: {
            store_secret: { action, content: {} },
          },
          requestState: first.requestState,
        })) as CallToolResult;

        expect((second as any).structuredContent).toEqual({
          status: action === 'decline' ? 'declined' : 'cancelled',
        });
      }
    });

    test('fresh call with recent secret returns stored true without elicitation', async () => {
      const { client } = await setupUrlCapable();

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
      project.status = 'ACTIVE_HEALTHY';

      // Set up a recent secret
      const now = Date.now();
      mockSecrets.set(project.id, [
        {
          name: 'MY_SECRET',
          value: 'secret-value',
          updated_at: new Date(now - 500_000).toISOString(),
        },
      ]);

      const result = await client.callTool({
        name: 'create_edge_function_secret',
        arguments: { project_id: project.id, name: 'MY_SECRET' },
      });

      expect((result as any).structuredContent?.stored).toBe(true);
      expect(
        (result as any).structuredContent?.updated_seconds_ago
      ).toBeGreaterThan(0);
      expect(
        (result as any).structuredContent?.updated_seconds_ago
      ).toBeLessThan(600);
    });

    test('replace true skips resume shortcut and issues elicitation', async () => {
      const { client } = await setupUrlCapable();

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
      project.status = 'ACTIVE_HEALTHY';

      // Secret updated 10 s ago
      mockSecrets.set(project.id, [
        {
          name: 'MY_SECRET',
          value: 'secret-value',
          updated_at: new Date(Date.now() - 10_000).toISOString(),
        },
      ]);

      const result = (await callModernTool(client, {
        name: 'create_edge_function_secret',
        arguments: {
          project_id: project.id,
          name: 'MY_SECRET',
          replace: true,
        },
      })) as CallToolResult | InputRequiredResult;

      if (!isInputRequiredResult(result)) {
        throw new Error('expected InputRequiredResult');
      }
      expect(result.inputRequests).toHaveProperty('store_secret');
    });

    test('rejects requestState minted by create_project', async () => {
      // Need form+url capabilities: form for create_project, url for create_edge_function_secret
      const { client } = await setupModern({
        clientCapabilities: { elicitation: { form: {}, url: {} } },
        secretCollection: SECRET_COLLECTION,
      });

      const org = await createOrganization({
        name: 'Paid Org',
        plan: 'pro',
        allowed_release_channels: ['ga'],
      });
      const existingProject = await createProject({
        name: 'Existing Project',
        region: 'us-east-1',
        organization_id: org.id,
      });
      existingProject.status = 'ACTIVE_HEALTHY';

      // Get a requestState from create_project (requires a pro org with existing project)
      const projectFirst = (await callModernTool(client, {
        name: 'create_project',
        arguments: {
          organization_id: org.id,
          name: 'My Project',
          region: 'us-east-1',
        },
      })) as CallToolResult | InputRequiredResult;

      if (!isInputRequiredResult(projectFirst)) {
        throw new Error(
          'expected an input_required result from create_project'
        );
      }

      const result = (await callModernTool(client, {
        name: 'create_edge_function_secret',
        arguments: { project_id: existingProject.id, name: 'MY_SECRET' },
        inputResponses: {
          store_secret: { action: 'accept', content: {} },
        },
        requestState: projectFirst.requestState,
      })) as CallToolResult;

      expect(result.isError).toBe(true);
    });

    test.each([
      { desc: 'empty', name: '' },
      { desc: 'whitespace-only', name: '  \t\n  ' },
    ])('rejects $desc secret name', async ({ name }) => {
      const { client } = await setupUrlCapable();

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
      project.status = 'ACTIVE_HEALTHY';

      const result = await callModernTool(client, {
        name: 'create_edge_function_secret',
        arguments: { project_id: project.id, name },
      });

      expect(isInputRequiredResult(result)).toBe(false);
      if (isInputRequiredResult(result)) {
        throw new Error('expected CallToolResult, not InputRequiredResult');
      }
      expect(result.isError).toBe(true);
    });

    test('replace true with insufficient permissions returns isError without URL', async () => {
      const { client } = await setupUrlCapable();

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
      project.status = 'ACTIVE_HEALTHY';

      // Mock a 403 response from the GET secrets endpoint
      harness.mockServer?.use(
        http.get(`${API_URL}/v1/projects/${project.id}/secrets`, () => {
          return HttpResponse.json({ message: 'Forbidden' }, { status: 403 });
        })
      );

      const result = (await callModernTool(client, {
        name: 'create_edge_function_secret',
        arguments: {
          project_id: project.id,
          name: 'MY_SECRET',
          replace: true,
        },
      })) as CallToolResult | InputRequiredResult;

      expect(isInputRequiredResult(result)).toBe(false);
      if (isInputRequiredResult(result)) {
        throw new Error('expected CallToolResult, not InputRequiredResult');
      }
      expect(result.isError).toBe(true);
    });

    test('tool absent when secretCollection not configured', async () => {
      const { client } = await setupModern({
        clientCapabilities: URL_CAPABLE,
        elicitation: {
          requestState: ELICITATION_REQUEST_STATE,
          confirmation: COST_CONFIRMATION,
        },
      });

      const { tools } = await client.listTools();
      const secretTool = tools.find(
        (tool) => tool.name === 'create_edge_function_secret'
      );

      expect(secretTool).toBeUndefined();
    });

    test('constructing server with template missing {name} placeholder throws', async () => {
      const platform = createSupabaseApiPlatform({
        accessToken: ACCESS_TOKEN,
        apiUrl: API_URL,
      });

      expect(() =>
        createSupabaseMcpServer({
          platform,
          elicitation: {
            requestState: ELICITATION_REQUEST_STATE,
            confirmation: COST_CONFIRMATION,
            secretCollection: {
              connectUrlTemplate:
                'https://supabase.com/dashboard/mcp/secrets?ref={ref}',
            },
          },
        })
      ).toThrow();
    });

    test('URL-only client keeps the legacy cost-confirmation lane for create_project', async () => {
      // A client that only declares `elicitation: { url: {} }` (no `form`
      // mode) is URL-capable but not form-capable. Its create_project stays
      // on the legacy get_cost -> confirm_cost -> confirm_cost_id flow even
      // though create_edge_function_secret elicits over the URL lane, and
      // both lanes must be exposed side by side from the same server.
      const { client } = await setupUrlCapable();

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toContain('get_cost');
      expect(names).toContain('confirm_cost');
      expect(names).toContain('create_edge_function_secret');

      const org = await createOrganization({
        name: 'URL-only client organization',
        plan: 'free',
        allowed_release_channels: ['ga'],
      });
      const args = {
        name: 'Legacy-confirmed project',
        region: 'us-east-1',
        organization_id: org.id,
      };
      const unconfirmed = await callModernTool(client, {
        name: 'create_project',
        arguments: args,
      });
      expect(isInputRequiredResult(unconfirmed)).toBe(false);
      expect(unconfirmed).toMatchObject({ isError: true });

      const confirmation = await client.callTool({
        name: 'confirm_cost',
        arguments: { type: 'project', recurrence: 'monthly', amount: 0 },
      });
      expect(confirmation.isError).not.toBe(true);
      const [confirmationContent] = confirmation.content;
      if (confirmationContent?.type !== 'text') {
        throw new Error('expected text content');
      }
      const { confirmation_id } = JSON.parse(confirmationContent.text);
      const created = await client.callTool({
        name: 'create_project',
        arguments: {
          ...args,
          confirm_cost_id: confirmation_id,
        },
      });
      expect(created.isError).not.toBe(true);
      const [projectContent] = created.content;
      if (projectContent?.type !== 'text') {
        throw new Error('expected text content');
      }
      expect(JSON.parse(projectContent.text)).toMatchObject(args);
    });

    test('URL-only configuration with no confirmation tools still elicits for the secret tool', async () => {
      // `elicitation.confirmation` is entirely absent here: create_project,
      // create_branch, execute_sql and apply_migration never touch the
      // confirmation lane, yet secretCollection alone must still stand up
      // the codec so create_edge_function_secret can elicit over URL.
      const { client } = await setupUrlCapable({
        elicitation: { requestState: ELICITATION_REQUEST_STATE },
      });

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toContain('create_edge_function_secret');
      expect(names).toContain('get_cost');
      expect(names).toContain('confirm_cost');

      const createProjectTool = tools.find(
        (tool) => tool.name === 'create_project'
      );
      expect(createProjectTool?.inputSchema.required).toContain(
        'confirm_cost_id'
      );

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
      project.status = 'ACTIVE_HEALTHY';

      const result = (await callModernTool(client, {
        name: 'create_edge_function_secret',
        arguments: { project_id: project.id, name: 'MY_SECRET' },
      })) as CallToolResult | InputRequiredResult;

      expect(isInputRequiredResult(result)).toBe(true);
    });
  });
  async function createActiveProject() {
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });
    return project;
  }
});
