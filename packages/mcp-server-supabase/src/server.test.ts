import { stripIndent } from 'common-tags';
import gqlmin from 'gqlmin';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { globalRegistry } from 'zod/v4';

import {
  contentApiMockSchema,
  createOrganization,
  createProject,
  createProjectFixture,
  mockContentApiSchemaLoadCount,
} from '../test/mocks.js';
import { createServerHarness } from '../test/server-harness.js';
import type { SupabasePlatform } from './platform/types.js';
import { instructions } from './server.js';
import { supabaseMcpToolSchemas } from './tools/tool-schemas.js';

const harness = createServerHarness();
const setup = harness.setup;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

describe('init', () => {
  test('server returns instructions', async () => {
    const { client } = await setup();
    expect(client.getInstructions()).toBe(instructions);
  });
});

describe('tools', () => {
  test('invalid access token', async () => {
    const { callTool } = await setup({ accessToken: 'bad-token' });

    const listOrganizationsPromise = callTool({
      name: 'list_organizations',
      arguments: {},
    });

    await expect(listOrganizationsPromise).rejects.toThrow('Unauthorized.');
  });

  // We use snake_case because it aligns better with most MCP clients
  test('all tools follow snake_case naming convention', async () => {
    const { client } = await setup();

    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.name, 'expected tool name to be snake_case').toMatch(
        /^[a-z0-9_]+$/
      );

      const parameterNames = Object.keys(tool.inputSchema.properties ?? {});
      for (const name of parameterNames) {
        expect(name, 'expected parameter to be snake_case').toMatch(
          /^[a-z0-9_]+$/
        );
      }
    }
  });

  test('all tools provide annotations', async () => {
    const { client } = await setup();

    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} tool`).toBeDefined();
      expect(tool.annotations!.title, `${tool.name} tool`).toBeDefined();
      expect(tool.annotations!.readOnlyHint, `${tool.name} tool`).toBeDefined();
      expect(
        tool.annotations!.destructiveHint,
        `${tool.name} tool`
      ).toBeDefined();
      expect(
        tool.annotations!.idempotentHint,
        `${tool.name} tool`
      ).toBeDefined();
      expect(
        tool.annotations!.openWorldHint,
        `${tool.name} tool`
      ).toBeDefined();
    }
  });

  test('all tools are included in supabaseMcpToolSchemas registry, including hidden tools', async () => {
    // Enable all features to ensure we check all possible tools
    const { client } = await setup({
      features: [
        'docs',
        'account',
        'database',
        'debugging',
        'development',
        'functions',
        'branching',
        'storage',
      ],
    });

    const { tools } = await client.listTools();

    // Check that every tool from the MCP server exists in the registry
    for (const tool of tools) {
      expect(
        supabaseMcpToolSchemas,
        `Tool "${tool.name}" should be in supabaseMcpToolSchemas registry`
      ).toHaveProperty(tool.name);
    }

    // Also verify that the registry doesn't have unexpected extra entries
    // (tools that don't exist in the server). A registry entry is allowed to
    // be missing from tools/list if its tool def is marked `hidden` — it
    // stays in the registry for typed access while being delisted from live
    // discovery (see CONTRIBUTING.md's tool deprecation guidance) — or if
    // its visibility is capability-dependent rather than a static def
    // property, like get_logs (hidden only when the platform also offers
    // query_logs).
    const registryToolNames = Object.keys(supabaseMcpToolSchemas);
    const serverToolNames = tools.map((t) => t.name);
    const conditionallyHiddenToolNames = new Set(['get_logs']);

    const extraToolsInRegistry = registryToolNames.filter(
      (name) => !serverToolNames.includes(name)
    );

    const unexpectedExtraTools = extraToolsInRegistry.filter(
      (name) =>
        !supabaseMcpToolSchemas[name as keyof typeof supabaseMcpToolSchemas]
          .hidden && !conditionallyHiddenToolNames.has(name)
    );

    expect(
      unexpectedExtraTools,
      'Registry should not contain tools that are not in the MCP server when all features are enabled, unless the tool is marked `hidden`'
    ).toEqual([]);
  });

  test('tool result content is valid JSON', async () => {
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const { client } = await setup({ projectId: project.id });
    const resultUntyped = await client.callTool({
      name: 'list_tables',
      arguments: { schemas: ['public'] },
    });

    const result = resultUntyped;
    const firstContent = result.content.at(0);
    if (!firstContent) {
      throw new Error('Expected content in tool response');
    }
    if (firstContent.type !== 'text') {
      throw new Error('Expected text content in tool response');
    }
    const parsedContent = JSON.parse(firstContent.text);
    expect(parsedContent).toBeTypeOf('object');
  });

  test('read-only mode excludes write tools from tools/list', async () => {
    const { callTool, client } = await setup({
      readOnly: true,
      features: [
        'docs',
        'account',
        'database',
        'debugging',
        'development',
        'functions',
        'branching',
        'storage',
      ],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toContain('execute_sql');
    expect(toolNames).not.toContain('apply_migration');
    expect(toolNames).not.toContain('deploy_edge_function');
    expect(toolNames).not.toContain('create_branch');
    expect(toolNames).not.toContain('delete_branch');
    expect(toolNames).not.toContain('update_storage_config');

    expect(
      tools
        .filter((tool) => tool.annotations?.readOnlyHint === false)
        .map((tool) => tool.name)
    ).toEqual([]);

    const result = callTool({
      name: 'apply_migration',
      arguments: {
        project_id: 'test-project-ref',
        name: 'test-migration',
        query: 'create table test (id int)',
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot apply migration in read-only mode.'
    );
  });
});

describe('feature groups', () => {
  test('account tools', async () => {
    const { client } = await setup({
      features: ['account'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'list_organizations',
      'get_organization',
      'list_projects',
      'get_project',
      'get_cost',
      'confirm_cost',
      'create_project',
      'pause_project',
      'restore_project',
    ]);
  });

  test('database tools', async () => {
    const { client } = await setup({
      features: ['database'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'list_tables',
      'list_extensions',
      'list_migrations',
      'apply_migration',
      'execute_sql',
    ]);
  });

  test('debugging tools hide get_logs in favor of query_logs when the platform supports it', async () => {
    const { client } = await setup({
      features: ['debugging'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(['query_logs', 'get_advisors']);
  });

  test('get_logs stays callable via tools/call even while hidden from tools/list', async () => {
    const { callTool } = await setup({
      features: ['debugging'],
    });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const { result } = await callTool({
      name: 'get_logs',
      arguments: {
        project_id: project.id,
        service: 'api',
      },
    });

    expect(result).toContain('untrusted-data');
  });

  test('debugging tools show get_logs when the platform does not implement query_logs', async () => {
    const platform: SupabasePlatform = {
      debugging: {
        getLogs() {
          throw new Error('Not implemented');
        },
        getSecurityAdvisors() {
          throw new Error('Not implemented');
        },
        getPerformanceAdvisors() {
          throw new Error('Not implemented');
        },
      },
    };

    const { client } = await setup({ platform, features: ['debugging'] });
    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(['get_logs', 'get_advisors']);
  });

  test('query_logs advertises the ClickHouse dialect by default', async () => {
    const { client } = await setup({ features: ['debugging'] });

    const { tools } = await client.listTools();
    const queryLogs = tools.find((tool) => tool.name === 'query_logs');
    const sqlDescription = (queryLogs?.inputSchema.properties as any)?.sql
      ?.description as string | undefined;

    expect(queryLogs?.description).toContain('ClickHouse');
    expect(sqlDescription).toContain("log_attributes['<key>']");
  });

  test('query_logs advertises the BigQuery dialect when the platform declares it', async () => {
    const platform: SupabasePlatform = {
      debugging: {
        logsDialect: 'bigquery',
        getLogs() {
          throw new Error('Not implemented');
        },
        queryLogs() {
          throw new Error('Not implemented');
        },
        getSecurityAdvisors() {
          throw new Error('Not implemented');
        },
        getPerformanceAdvisors() {
          throw new Error('Not implemented');
        },
      },
    };

    const { client } = await setup({ platform, features: ['debugging'] });

    const { tools } = await client.listTools();
    const queryLogs = tools.find((tool) => tool.name === 'query_logs');
    const sqlDescription = (queryLogs?.inputSchema.properties as any)?.sql
      ?.description as string | undefined;

    expect(queryLogs?.description).toContain('BigQuery');
    expect(queryLogs?.description).not.toContain('ClickHouse');
    expect(sqlDescription).toContain('unnest(metadata)');
    expect(sqlDescription).not.toContain('log_attributes');
    // Self-hosted BigQuery (Logflare) does not serve these sources, so the hint
    // must not advertise them (see apps/studio/lib/api/self-hosted/logs.ts).
    expect(sqlDescription).not.toContain('function_logs');
    expect(sqlDescription).not.toContain('workflow_run_logs');
  });

  test('query_logs falls back to the ClickHouse dialect when logsDialect is unset', async () => {
    const platform: SupabasePlatform = {
      debugging: {
        getLogs() {
          throw new Error('Not implemented');
        },
        queryLogs() {
          throw new Error('Not implemented');
        },
        getSecurityAdvisors() {
          throw new Error('Not implemented');
        },
        getPerformanceAdvisors() {
          throw new Error('Not implemented');
        },
      },
    };

    const { client } = await setup({ platform, features: ['debugging'] });

    const { tools } = await client.listTools();
    const queryLogs = tools.find((tool) => tool.name === 'query_logs');
    const sqlDescription = (queryLogs?.inputSchema.properties as any)?.sql
      ?.description as string | undefined;

    expect(queryLogs?.description).toContain('ClickHouse');
    expect(sqlDescription).toContain("log_attributes['<key>']");
  });

  test('development tools', async () => {
    const { client } = await setup({
      features: ['development'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'get_project_url',
      'get_publishable_keys',
      'generate_typescript_types',
    ]);
  });

  test('docs tools', async () => {
    const { client } = await setup({
      features: ['docs'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(['search_docs']);
  });

  test('functions tools', async () => {
    const { client } = await setup({
      features: ['functions'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'list_edge_functions',
      'get_edge_function',
      'deploy_edge_function',
    ]);
  });

  test('branching tools', async () => {
    const { client } = await setup({
      features: ['branching'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'create_branch',
      'list_branches',
      'delete_branch',
      'merge_branch',
      'reset_branch',
      'rebase_branch',
    ]);
  });

  test('storage tools', async () => {
    const { client } = await setup({
      features: ['storage'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'list_storage_buckets',
      'get_storage_config',
      'update_storage_config',
    ]);
  });

  test('invalid group fails', async () => {
    const setupPromise = setup({
      features: ['my-invalid-group'],
    });

    await expect(setupPromise).rejects.toThrow('Invalid input');
  });

  test('duplicate group behaves like single group', async () => {
    const { client: duplicateClient } = await setup({
      features: ['account', 'account'],
    });

    const { tools } = await duplicateClient.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'list_organizations',
      'get_organization',
      'list_projects',
      'get_project',
      'get_cost',
      'confirm_cost',
      'create_project',
      'pause_project',
      'restore_project',
    ]);
  });

  test('tools filtered to available platform operations', async () => {
    const platform: SupabasePlatform = {
      database: {
        executeSql() {
          throw new Error('Not implemented');
        },
        listMigrations() {
          throw new Error('Not implemented');
        },
        applyMigration() {
          throw new Error('Not implemented');
        },
      },
    };

    const { client } = await setup({ platform });
    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'search_docs',
      'list_tables',
      'list_extensions',
      'list_migrations',
      'apply_migration',
      'execute_sql',
    ]);
  });

  test('unimplemented feature group produces custom error message', async () => {
    const platform: SupabasePlatform = {
      database: {
        executeSql() {
          throw new Error('Not implemented');
        },
        listMigrations() {
          throw new Error('Not implemented');
        },
        applyMigration() {
          throw new Error('Not implemented');
        },
      },
    };

    const setupPromise = setup({ platform, features: ['account'] });

    await expect(setupPromise).rejects.toThrow(
      "This platform does not support the 'account' feature group"
    );
  });
});

describe('project scoped tools', () => {
  test('no account level tools should exist', async () => {
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

    const { client } = await setup({ projectId: project.id });

    const result = await client.listTools();

    const accountLevelToolNames = [
      'list_organizations',
      'get_organization',
      'list_projects',
      'get_project',
      'get_cost',
      'confirm_cost',
      'create_project',
      'pause_project',
      'restore_project',
    ];

    const toolNames = result.tools.map((tool) => tool.name);

    for (const accountLevelToolName of accountLevelToolNames) {
      expect(
        toolNames,
        `tool ${accountLevelToolName} should not be available in project scope`
      ).not.toContain(accountLevelToolName);
    }
  });

  test('no tool should accept a project_id', async () => {
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

    const { client } = await setup({ projectId: project.id });

    const result = await client.listTools();

    expect(result.tools).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);

    for (const tool of result.tools) {
      const schemaProperties = tool.inputSchema.properties ?? {};
      expect(
        'project_id' in schemaProperties,
        `tool ${tool.name} should not accept a project_id`
      ).toBe(false);
    }
  });

  test('invalid project ID should throw an error', async () => {
    const { callTool } = await setup({ projectId: 'invalid-project-id' });

    const listTablesPromise = callTool({
      name: 'list_tables',
      arguments: {
        schemas: ['public'],
      },
    });

    await expect(listTablesPromise).rejects.toThrow('Project not found');
  });

  test('passing project_id to a tool should throw an error', async () => {
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const { callTool } = await setup({ projectId: project.id });

    const listTablesPromise = callTool({
      name: 'list_tables',
      arguments: {
        project_id: 'my-project-id',
        schemas: ['public'],
      },
    });

    await expect(listTablesPromise).rejects.toThrow('Unrecognized key');
  });

  test('listing tables implicitly uses the scoped project_id', async () => {
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db
      .sql`create table test (id integer generated always as identity primary key)`;

    const { callTool } = await setup({ projectId: project.id });

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        schemas: ['public'],
        verbose: true,
      },
    });

    expect(result.tables).toEqual([
      expect.objectContaining({
        name: 'public.test',
        columns: [
          expect.objectContaining({
            name: 'id',
            options: expect.arrayContaining(['identity']),
          }),
        ],
      }),
    ]);
  });
});

describe('docs tools', () => {
  test('gets content', async () => {
    const { callTool } = await setup();
    const query = stripIndent`
      query ContentQuery {
        searchDocs(query: "typescript") {
          nodes {
            title
            href
          }
        }
      }
    `;

    const result = await callTool({
      name: 'search_docs',
      arguments: {
        graphql_query: query,
      },
    });

    expect(result).toEqual({ result: { dummy: true } });
  });

  test('tool description contains schema', async () => {
    const { client } = await setup();

    const { tools } = await client.listTools();

    const tool = tools.find((tool) => tool.name === 'search_docs');

    if (!tool) {
      throw new Error('tool not found');
    }

    if (!tool.description) {
      throw new Error('tool description not found');
    }

    const minifiedSchema = gqlmin(contentApiMockSchema);
    expect(tool.description.includes(minifiedSchema)).toBe(true);
  });

  test('schema is only loaded when listing tools', async () => {
    const { client, callTool } = await setup();

    expect(mockContentApiSchemaLoadCount.value).toBe(0);

    // "tools/list" requests fetch the schema
    await client.listTools();
    expect(mockContentApiSchemaLoadCount.value).toBe(1);

    // "tools/call" should not fetch the schema again
    await callTool({
      name: 'search_docs',
      arguments: {
        graphql_query: '{ searchDocs(query: "test") { nodes { title } } }',
      },
    });
    expect(mockContentApiSchemaLoadCount.value).toBe(1);

    // Additional "tools/list" requests fetch the schema again
    await client.listTools();
    expect(mockContentApiSchemaLoadCount.value).toBe(2);
  });
});

describe('zod registry', () => {
  // Zod schemas with `.describe()` auto-register in the global registry. If schemas are defined
  // inside functions (rather than at module level), new instances register on every call,
  // causing unbounded memory growth.
  test('creating multiple servers does not cause unbounded registry growth', async () => {
    const addSpy = vi.spyOn(globalRegistry, 'add');

    try {
      for (let i = 0; i < 9; i++) {
        const { client } = await setup();
        await client.listTools();
      }

      const registryAdditions = addSpy.mock.calls.length;
      expect(registryAdditions).toBe(0);
    } finally {
      addSpy.mockRestore();
    }
  });
});
