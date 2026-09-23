import { ACCESS_TOKEN, API_URL, createProjectFixture } from '../test/mocks.js';
import { callModernTool, createServerHarness } from '../test/server-harness.js';
import { createSupabaseApiPlatform } from './platform/api-platform.js';
import type { SupabaseMcpServerOptions } from './server.js';
import * as destructiveSql from './tools/destructive-sql.js';
import { isInputRequiredResult } from '@modelcontextprotocol/client';
import type {
  CallToolRequestParams,
  CallToolResult,
  ClientCapabilities,
  InputRequiredResult,
} from '@modelcontextprotocol/client';
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

describe('tools', () => {
  test('execute sql', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const query = 'select 1+1 as sum';

    const result = await callTool({
      name: 'execute_sql',
      arguments: {
        project_id: project.id,
        query,
      },
    });

    expect(result.result).toContain('untrusted user data');
    expect(result.result).toMatch(
      /<untrusted-data-\w{8}-\w{4}-\w{4}-\w{4}-\w{12}>/
    );
    expect(result.result).toContain(JSON.stringify([{ sum: 2 }]));
    expect(result.result).toMatch(
      /<\/untrusted-data-\w{8}-\w{4}-\w{4}-\w{4}-\w{12}>/
    );
  });

  test('can run read queries in read-only mode', async () => {
    const { callTool } = await setup({ readOnly: true });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const query = 'select 1+1 as sum';

    const result = await callTool({
      name: 'execute_sql',
      arguments: {
        project_id: project.id,
        query,
      },
    });

    expect(result.result).toContain('untrusted user data');
    expect(result.result).toMatch(
      /<untrusted-data-\w{8}-\w{4}-\w{4}-\w{4}-\w{12}>/
    );
    expect(result.result).toContain(JSON.stringify([{ sum: 2 }]));
    expect(result.result).toMatch(
      /<\/untrusted-data-\w{8}-\w{4}-\w{4}-\w{4}-\w{12}>/
    );
  });

  test('cannot run write queries in read-only mode', async () => {
    const { callTool } = await setup({ readOnly: true });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const query =
      'create table test (id integer generated always as identity primary key)';

    const resultPromise = callTool({
      name: 'execute_sql',
      arguments: {
        project_id: project.id,
        query,
      },
    });

    await expect(resultPromise).rejects.toThrow(
      'permission denied for schema public'
    );
  });

  test('apply migration, list migrations, check tables', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const name = 'test_migration';
    const query =
      'create table test (id integer generated always as identity primary key)';

    const result = await callTool({
      name: 'apply_migration',
      arguments: {
        project_id: project.id,
        name,
        query,
      },
    });

    expect(result).toEqual({ success: true });

    const listMigrationsResult = await callTool({
      name: 'list_migrations',
      arguments: {
        project_id: project.id,
      },
    });

    expect(listMigrationsResult.migrations).toEqual([
      {
        name,
        version: expect.stringMatching(/^\d{14}$/),
      },
    ]);

    const listTablesResult = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    expect(listTablesResult.tables).toEqual([
      {
        name: 'public.test',
        rls_enabled: false,
        rows: 0,
        columns: [
          {
            name: 'id',
            data_type: 'integer',
            format: 'int4',
            options: ['identity', 'updatable'],
            identity_generation: 'ALWAYS',
          },
        ],
        primary_keys: ['id'],
      },
    ]);
    expect(listTablesResult.advisory).toEqual(
      expect.objectContaining({ id: 'rls_disabled' })
    );
  });

  test('list_tables returns compact summary by default', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(
      'create table test (id integer generated always as identity primary key)'
    );

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
      },
    });

    expect(result).toEqual({
      tables: [
        {
          name: 'public.test',
          rls_enabled: false,
          rows: 0,
        },
      ],
      advisory: {
        id: 'rls_disabled',
        priority: 1,
        level: 'critical',
        title: 'Row Level Security is disabled',
        message: expect.stringContaining('public.test'),
        remediation_sql:
          'ALTER TABLE "public"."test" ENABLE ROW LEVEL SECURITY;',
        doc_url: expect.stringContaining('row-level-security'),
      },
    });
  });

  test('list_tables returns full details when verbose is true', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table users (id integer generated always as identity primary key);
      create table orders (
        id integer generated always as identity primary key,
        user_id integer references users(id)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    // Verbose mode should include columns, primary_keys, and foreign_key_constraints
    const ordersTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.orders'
    );
    expect(ordersTable).toEqual(
      expect.objectContaining({
        columns: expect.arrayContaining([
          expect.objectContaining({ name: 'id' }),
          expect.objectContaining({ name: 'user_id' }),
        ]),
        primary_keys: ['id'],
        foreign_key_constraints: [
          expect.objectContaining({
            source_table: 'public.orders',
            source_columns: ['user_id'],
            target_table: 'public.users',
            target_columns: ['id'],
          }),
        ],
      })
    );
  });

  test('composite FK is grouped as one constraint with positionally ordered columns', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table parent (
        y int,
        x int,
        primary key (y, x)
      );
      create table child (
        b int,
        a int,
        constraint child_parent_fk
          foreign key (b, a) references parent (y, x)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const childTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.child'
    );

    // exactly one constraint row - not one per column pair
    expect(childTable.foreign_key_constraints).toHaveLength(1);
    expect(childTable.foreign_key_constraints[0]).toEqual(
      expect.objectContaining({
        name: 'child_parent_fk',
        source_table: 'public.child',
        source_columns: ['b', 'a'],
        target_table: 'public.parent',
        target_columns: ['y', 'x'],
      })
    );
  });

  test('single-column FK is represented with one-element arrays', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table parent (
        id int primary key
      );
      create table child (
        parent_id int,
        constraint child_parent_fk
          foreign key (parent_id) references parent (id)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const childTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.child'
    );

    expect(childTable.foreign_key_constraints).toHaveLength(1);
    expect(childTable.foreign_key_constraints[0]).toEqual(
      expect.objectContaining({
        name: 'child_parent_fk',
        source_table: 'public.child',
        source_columns: ['parent_id'],
        target_table: 'public.parent',
        target_columns: ['id'],
      })
    );
  });

  test('self-referential composite FK is reported once with correct pairing', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table node (
        a int,
        b int,
        parent_a int,
        parent_b int,
        primary key (a, b),
        constraint node_parent_fk
          foreign key (parent_a, parent_b) references node (a, b)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const nodeTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.node'
    );

    const selfFk = nodeTable.foreign_key_constraints.filter(
      (fk: { name: string }) => fk.name === 'node_parent_fk'
    );
    expect(selfFk).toHaveLength(1);
    expect(selfFk[0]).toEqual(
      expect.objectContaining({
        source_table: 'public.node',
        source_columns: ['parent_a', 'parent_b'],
        target_table: 'public.node',
        target_columns: ['a', 'b'],
      })
    );
  });

  test('two independent composite FKs between the same tables stay separate', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table parent (
        x int,
        y int,
        primary key (x, y)
      );
      create table child (
        a1 int,
        a2 int,
        b1 int,
        b2 int,
        constraint child_fk_a
          foreign key (a1, a2) references parent (x, y),
        constraint child_fk_b
          foreign key (b1, b2) references parent (x, y)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const childTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.child'
    );

    const fkA = childTable.foreign_key_constraints.find(
      (fk: { name: string }) => fk.name === 'child_fk_a'
    );
    const fkB = childTable.foreign_key_constraints.find(
      (fk: { name: string }) => fk.name === 'child_fk_b'
    );
    expect(fkA).toEqual(
      expect.objectContaining({
        source_columns: ['a1', 'a2'],
        target_columns: ['x', 'y'],
      })
    );
    expect(fkB).toEqual(
      expect.objectContaining({
        source_columns: ['b1', 'b2'],
        target_columns: ['x', 'y'],
      })
    );
  });

  test('three-column composite FK preserves column order', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table parent (
        p int,
        q int,
        r int,
        primary key (p, q, r)
      );
      create table child (
        c int,
        b int,
        a int,
        constraint child_parent_fk
          foreign key (c, b, a) references parent (p, q, r)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const childTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.child'
    );

    expect(childTable.foreign_key_constraints).toHaveLength(1);
    expect(childTable.foreign_key_constraints[0]).toEqual(
      expect.objectContaining({
        source_columns: ['c', 'b', 'a'],
        target_columns: ['p', 'q', 'r'],
      })
    );
  });

  test('cross-schema composite FK is schema-qualified on both sides', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create schema other;
      create table other.parent (
        x int,
        y int,
        primary key (x, y)
      );
      create table child (
        a int,
        b int,
        constraint child_parent_fk
          foreign key (a, b) references other.parent (x, y)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public', 'other'],
        verbose: true,
      },
    });

    const childTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.child'
    );

    expect(childTable.foreign_key_constraints).toHaveLength(1);
    expect(childTable.foreign_key_constraints[0]).toEqual(
      expect.objectContaining({
        source_table: 'public.child',
        source_columns: ['a', 'b'],
        target_table: 'other.parent',
        target_columns: ['x', 'y'],
      })
    );
  });

  test('composite FK referencing a non-primary unique constraint is grouped correctly', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table parent (
        id int primary key,
        x int,
        y int,
        constraint parent_xy_unique unique (x, y)
      );
      create table child (
        a int,
        b int,
        constraint child_parent_fk
          foreign key (a, b) references parent (x, y)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const childTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.child'
    );

    expect(childTable.foreign_key_constraints).toHaveLength(1);
    expect(childTable.foreign_key_constraints[0]).toEqual(
      expect.objectContaining({
        name: 'child_parent_fk',
        source_columns: ['a', 'b'],
        target_columns: ['x', 'y'],
      })
    );
  });

  test('same constraint name on different tables is not merged', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table parent (
        id int primary key
      );
      create table child_a (
        parent_id int,
        constraint fk_parent
          foreign key (parent_id) references parent (id)
      );
      create table child_b (
        parent_id int,
        constraint fk_parent
          foreign key (parent_id) references parent (id)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const childA = result.tables.find(
      (t: { name: string }) => t.name === 'public.child_a'
    );
    const childB = result.tables.find(
      (t: { name: string }) => t.name === 'public.child_b'
    );

    expect(
      childA.foreign_key_constraints.filter(
        (fk: { name: string }) => fk.name === 'fk_parent'
      )
    ).toHaveLength(1);
    expect(
      childB.foreign_key_constraints.filter(
        (fk: { name: string }) => fk.name === 'fk_parent'
      )
    ).toHaveLength(1);
  });

  test('list_tables omits advisory when all tables have RLS enabled', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table test (id serial primary key);
      alter table test enable row level security;
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
      },
    });

    expect(result.tables[0].rls_enabled).toBe(true);
    expect(result.advisory).toBeUndefined();
  });

  test('cannot apply migration in read-only mode', async () => {
    const { callTool } = await setup({ readOnly: true });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const name = 'test-migration';
    const query =
      'create table test (id integer generated always as identity primary key)';

    const resultPromise = callTool({
      name: 'apply_migration',
      arguments: {
        project_id: project.id,
        name,
        query,
      },
    });

    await expect(resultPromise).rejects.toThrow(
      'Cannot apply migration in read-only mode.'
    );
  });

  test('list tables only under a specific schema', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec('create schema test;');
    await project.db.exec(
      'create table public.test_1 (id serial primary key);'
    );
    await project.db.exec('create table test.test_2 (id serial primary key);');

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['test'],
      },
    });

    expect(result.tables).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'test.test_2' })])
    );
    expect(result.tables).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'test.test_1' })])
    );
  });

  test('listing all tables excludes system schemas', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ schema: 'pg_catalog' }),
      ])
    );

    expect(result).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ schema: 'information_schema' }),
      ])
    );

    expect(result).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ schema: 'pg_toast' })])
    );
  });

  test('list_tables is not vulnerable to SQL injection via schemas parameter', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'SQLi Org', allowed_release_channels: ['ga'] },
      project: { name: 'SQLi Project', region: 'us-east-1' },
    });

    // Attempt SQL injection via schemas parameter using payload from HackerOne report
    // This payload attempts to break out of the string and inject a division by zero expression
    // Reference: https://linear.app/supabase/issue/AI-139
    const maliciousSchema = "public') OR (SELECT 1)=1/0--";

    // With proper parameterization, this should NOT throw "division by zero" error
    // The literal schema name doesn't exist, so it should return empty array
    // WITHOUT parameterization, this would throw: "division by zero" error
    const maliciousResult = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: [maliciousSchema],
      },
    });

    // Should return empty array without errors, proving the SQL injection was prevented
    expect(maliciousResult.tables).toEqual([]);
  });

  test('list extensions', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const result = await callTool({
      name: 'list_extensions',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result.extensions).toMatchInlineSnapshot(`
      [
        {
          "comment": "PL/pgSQL procedural language",
          "default_version": "1.0",
          "installed_version": "1.0",
          "name": "plpgsql",
          "schema": "pg_catalog",
        },
      ]
    `);
  });

  const projectScopedDbTools = [
    {
      tool: 'execute_sql',
      method: 'post',
      endpoint: '/v1/projects/:projectId/database/query',
      args: (projectId: string) => ({
        project_id: projectId,
        query: 'select 1;',
      }),
    },
    {
      tool: 'list_tables',
      method: 'post',
      endpoint: '/v1/projects/:projectId/database/query',
      args: (projectId: string) => ({ project_id: projectId }),
    },
    {
      tool: 'list_extensions',
      method: 'post',
      endpoint: '/v1/projects/:projectId/database/query',
      args: (projectId: string) => ({ project_id: projectId }),
    },
    {
      tool: 'list_migrations',
      method: 'get',
      endpoint: '/v1/projects/:projectId/database/migrations',
      args: (projectId: string) => ({ project_id: projectId }),
    },
    {
      tool: 'apply_migration',
      method: 'post',
      endpoint: '/v1/projects/:projectId/database/migrations',
      args: (projectId: string) => ({
        project_id: projectId,
        name: 'test-migration',
        query: 'select 1;',
      }),
    },
  ] as const;

  test.each(projectScopedDbTools)(
    'permission denied for $tool suggests checking organization',
    async ({ tool, method, endpoint, args }) => {
      const { callTool } = await setup();

      const { project } = await createProjectFixture({
        organization: { name: 'My Org', allowed_release_channels: ['ga'] },
        project: { name: 'Project 1', region: 'us-east-1' },
      });

      harness.mockServer?.use(
        http[method](`${API_URL}${endpoint}`, () =>
          HttpResponse.json(
            { message: 'You do not have permission to perform this action' },
            { status: 403 }
          )
        )
      );

      const resultPromise = callTool({
        name: tool,
        arguments: args(project.id),
      });

      await expect(resultPromise).rejects.toThrow(
        `You do not have permission to perform this action. Access to project '${project.id}' was denied. If this project exists, your access token may be scoped to a different organization: re-authenticate with the MCP server and select the organization that owns this project.`
      );
    }
  );

  test('permission denied with no upstream message falls back to a generic prefix', async () => {
    const { callTool } = await setup();

    const { organization: org, project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    // A 403 whose body has no `message` field (the missing-message wrong-org
    // case) falls back to the generic prefix.
    harness.mockServer?.use(
      http.post(`${API_URL}/v1/projects/:projectId/database/query`, () =>
        HttpResponse.json({}, { status: 403 })
      )
    );

    const executeSqlPromise = callTool({
      name: 'execute_sql',
      arguments: {
        project_id: project.id,
        query: 'select 1;',
      },
    });

    await expect(executeSqlPromise).rejects.toThrow(
      `Failed to execute SQL query. Access to project '${project.id}' was denied. If this project exists, your access token may be scoped to a different organization: re-authenticate with the MCP server and select the organization that owns this project.`
    );
  });

  test('invalid sql for apply_migration', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const name = 'test-migration';
    const query = 'invalid sql';

    const applyMigrationPromise = callTool({
      name: 'apply_migration',
      arguments: {
        project_id: project.id,
        name,
        query,
      },
    });

    await expect(applyMigrationPromise).rejects.toThrow(
      'syntax error at or near "invalid"'
    );
  });

  test('invalid sql for execute_sql', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    const query = 'invalid sql';

    const executeSqlPromise = callTool({
      name: 'execute_sql',
      arguments: {
        project_id: project.id,
        query,
      },
    });

    await expect(executeSqlPromise).rejects.toThrow(
      'syntax error at or near "invalid"'
    );
  });
  async function createActiveProject() {
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });
    return project;
  }

  describe('execute_sql destructive confirmation via elicitation', () => {
    test.each(['execute_sql', 'apply_migration'] as const)(
      '%s accepted retry executes original SQL when classification is unavailable',
      async (tool) => {
        const { client, platform } = await setupModern({
          clientCapabilities: FORM_CAPABLE,
        });
        const query = '-- preserve this comment\nDROP TABLE films;';
        const args = {
          project_id: 'test-project',
          query,
          ...(tool === 'apply_migration' && { name: 'drop_films' }),
        };
        const executeSql = vi
          .spyOn(platform.database!, 'executeSql')
          .mockResolvedValue([]);
        const applyMigration = vi
          .spyOn(platform.database!, 'applyMigration')
          .mockResolvedValue(undefined);
        const originalClassify = destructiveSql.isDestructiveSql;
        const classify = vi.spyOn(destructiveSql, 'isDestructiveSql');
        try {
          classify.mockImplementation(() => {
            throw new Error('classification unavailable');
          });
          const initialFailure = await callModernTool(client, {
            name: tool,
            arguments: args,
          });
          expect(initialFailure).toMatchObject({ isError: true });
          expect(isInputRequiredResult(initialFailure)).toBe(false);
          expect(executeSql).not.toHaveBeenCalled();
          expect(applyMigration).not.toHaveBeenCalled();
          classify.mockImplementation(originalClassify);

          const first = await callModernTool(client, {
            name: tool,
            arguments: args,
          });
          if (!isInputRequiredResult(first)) {
            throw new Error('expected an issued SQL confirmation');
          }
          expect(executeSql).not.toHaveBeenCalled();
          expect(applyMigration).not.toHaveBeenCalled();
          classify.mockImplementation(() => {
            throw new Error('classification unavailable');
          });
          for (const action of [undefined, 'decline', 'cancel'] as const) {
            const unaccepted = await callModernTool(client, {
              name: tool,
              arguments: args,
              requestState: first.requestState,
              ...(action && {
                inputResponses: {
                  confirm_destructive: { action },
                },
              }),
            });
            // Non-acceptance retains classification failure precedence.
            expect(unaccepted).toMatchObject({ isError: true });
            expect(executeSql).not.toHaveBeenCalled();
            expect(applyMigration).not.toHaveBeenCalled();
          }

          const accepted = await callModernTool(client, {
            name: tool,
            arguments: args,
            requestState: first.requestState,
            inputResponses: {
              confirm_destructive: { action: 'accept', content: {} },
            },
          });
          expect(isInputRequiredResult(accepted)).toBe(false);
          expect((accepted as CallToolResult).isError).not.toBe(true);
          if (tool === 'execute_sql') {
            expect(executeSql).toHaveBeenCalledWith(
              'test-project',
              expect.objectContaining({ query })
            );
            expect(applyMigration).not.toHaveBeenCalled();
          } else {
            expect(applyMigration).toHaveBeenCalledWith('test-project', {
              name: 'drop_films',
              query,
            });
            expect((accepted as CallToolResult).content).toContainEqual({
              type: 'text',
              text: JSON.stringify({ success: true }),
            });
            expect(executeSql).not.toHaveBeenCalled();
          }
        } finally {
          classify.mockRestore();
          await client.close();
        }
      }
    );

    test('form-capable client: non-destructive SQL runs without elicitation', async () => {
      const { client, platform } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
      });
      const project = await createActiveProject();
      const executeSql = vi.spyOn(platform.database!, 'executeSql');

      await client.callTool({
        name: 'execute_sql',
        arguments: { project_id: project.id, query: 'select 1' },
      });

      expect(executeSql).toHaveBeenCalledOnce();
    });

    test.each([
      ['execute_sql', 'apply_migration'],
      ['apply_migration', 'execute_sql'],
    ] as const)(
      'form-capable client: only $enabledTool elicits when the other SQL tool is disabled',
      async (enabledTool, disabledTool) => {
        const { client, platform } = await setupModern({
          clientCapabilities: FORM_CAPABLE,
          elicitation: {
            requestState: ELICITATION_REQUEST_STATE,
            confirmation: {
              ...COST_CONFIRMATION,
              enabledTools: [enabledTool],
            },
          },
          elicitationAction: 'decline',
        });
        const project = await createActiveProject();
        await project.db.exec('create table films (id int)');
        const executeSql = vi.spyOn(platform.database!, 'executeSql');
        const applyMigration = vi.spyOn(platform.database!, 'applyMigration');
        const toolCalls = {
          execute_sql: {
            name: 'execute_sql',
            arguments: {
              project_id: project.id,
              query: 'drop table films;',
            },
          },
          apply_migration: {
            name: 'apply_migration',
            arguments: {
              project_id: project.id,
              name: 'drop_films',
              query: 'drop table films;',
            },
          },
        } satisfies Record<
          'execute_sql' | 'apply_migration',
          CallToolRequestParams
        >;
        const operations = {
          execute_sql: executeSql,
          apply_migration: applyMigration,
        };

        const enabledResult = await client.callTool(toolCalls[enabledTool]);

        expect(enabledResult.structuredContent).toEqual({
          status: 'declined',
        });
        expect(operations[enabledTool]).not.toHaveBeenCalled();

        await client.callTool(toolCalls[disabledTool]);

        expect(operations[disabledTool]).toHaveBeenCalledOnce();
      }
    );

    test('form-capable client: accept runs destructive SQL exactly once', async () => {
      const { client, platform } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'accept',
      });
      const project = await createActiveProject();
      await project.db.exec('create table films (id int)');
      const executeSql = vi.spyOn(platform.database!, 'executeSql');

      const result = await client.callTool({
        name: 'execute_sql',
        arguments: { project_id: project.id, query: 'drop table films;' },
      });

      expect(executeSql).toHaveBeenCalledOnce();
      expect(result.isError).toBeFalsy();
    });

    test('form-capable client: decline does not run the SQL', async () => {
      const { client, platform } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'decline',
      });
      const project = await createActiveProject();
      const executeSql = vi.spyOn(platform.database!, 'executeSql');

      const result = await client.callTool({
        name: 'execute_sql',
        arguments: { project_id: project.id, query: 'drop table films;' },
      });

      expect(result.structuredContent).toEqual({ status: 'declined' });
      expect(executeSql).not.toHaveBeenCalled();
    });

    test('form-capable client: declining bare-column DROP preserves the column and its data', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'decline',
      });
      const project = await createActiveProject();
      try {
        await project.db.exec(
          "create table films (id int, title text); insert into films values (1, 'Alien');"
        );

        const result = await client.callTool({
          name: 'execute_sql',
          arguments: {
            project_id: project.id,
            query: 'ALTER TABLE films DROP title;',
          },
        });

        const { rows } = await project.db.query(
          'select to_jsonb(films) as film from films'
        );
        expect(rows).toEqual([{ film: { id: 1, title: 'Alien' } }]);
        expect(result.structuredContent).toEqual({ status: 'declined' });
      } finally {
        await client.close();
        await project.destroy();
      }
    });

    test('rejects a retry whose query changed since the state was minted', async () => {
      const { client, platform } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
      });
      const project = await createActiveProject();
      const executeSql = vi.spyOn(platform.database!, 'executeSql');

      const first = (await callModernTool(client, {
        name: 'execute_sql',
        arguments: {
          project_id: project.id,
          query: 'drop table films;',
        },
      })) as CallToolResult | InputRequiredResult;
      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }

      const second = (await callModernTool(client, {
        name: 'execute_sql',
        arguments: {
          project_id: project.id,
          query: 'drop table actors;',
        },
        inputResponses: {
          confirm_destructive: { action: 'accept', content: {} },
        },
        requestState: first.requestState,
      })) as CallToolResult | InputRequiredResult;

      if (isInputRequiredResult(second)) {
        throw new Error('expected a CallToolResult');
      }
      expect(second.content).toContainEqual({
        type: 'text',
        text: 'Request state arguments do not match the current arguments.',
      });
      expect(second.structuredContent).toEqual({ status: 'error' });
      expect(second.isError).toBe(true);
      expect(executeSql).not.toHaveBeenCalled();
    });

    test('capability-free client runs destructive SQL without elicitation when confirmation is configured', async () => {
      const platform = createSupabaseApiPlatform({
        accessToken: ACCESS_TOKEN,
        apiUrl: API_URL,
      });
      const executeSql = vi.spyOn(platform.database!, 'executeSql');
      const { client } = await setup({
        platform,
        elicitation: {
          requestState: ELICITATION_REQUEST_STATE,
          confirmation: COST_CONFIRMATION,
        },
      });
      const project = await createActiveProject();

      await client.callTool({
        name: 'execute_sql',
        arguments: { project_id: project.id, query: 'drop table films;' },
      });

      expect(executeSql).toHaveBeenCalledOnce();
    });

    test('read-only server does not elicit for destructive SQL', async () => {
      const { client, platform } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        readOnly: true,
      });
      const project = await createActiveProject();
      const executeSql = vi.spyOn(platform.database!, 'executeSql');

      await client.callTool({
        name: 'execute_sql',
        arguments: { project_id: project.id, query: 'drop table films;' },
      });

      expect(executeSql).toHaveBeenCalledWith(project.id, {
        query: 'drop table films;',
        read_only: true,
      });
    });
  });

  describe('apply_migration destructive confirmation via elicitation', () => {
    test('form-capable client: accept applies the migration exactly once from the signed state', async () => {
      const { client, platform } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'accept',
      });
      const project = await createActiveProject();
      await project.db.exec('create table films (id int)');
      const applyMigration = vi.spyOn(platform.database!, 'applyMigration');

      const result = await client.callTool({
        name: 'apply_migration',
        arguments: {
          project_id: project.id,
          name: 'drop_films',
          query: 'drop table films;',
        },
      });

      expect(applyMigration).toHaveBeenCalledOnce();
      expect(applyMigration).toHaveBeenCalledWith(project.id, {
        name: 'drop_films',
        query: 'drop table films;',
      });
      expect(result.isError).toBeFalsy();
    });

    test('form-capable client: decline does not apply the migration', async () => {
      const { client, platform } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'decline',
      });
      const project = await createActiveProject();
      const applyMigration = vi.spyOn(platform.database!, 'applyMigration');

      const result = await client.callTool({
        name: 'apply_migration',
        arguments: {
          project_id: project.id,
          name: 'drop_films',
          query: 'drop table films;',
        },
      });

      expect(result.structuredContent).toEqual({ status: 'declined' });
      expect(applyMigration).not.toHaveBeenCalled();
    });

    test('rejects a retry whose migration name changed since the state was minted', async () => {
      const { client, platform } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
      });
      const project = await createActiveProject();
      const applyMigration = vi.spyOn(platform.database!, 'applyMigration');

      const first = (await callModernTool(client, {
        name: 'apply_migration',
        arguments: {
          project_id: project.id,
          name: 'drop_films',
          query: 'drop table films;',
        },
      })) as CallToolResult | InputRequiredResult;
      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }

      const second = (await callModernTool(client, {
        name: 'apply_migration',
        arguments: {
          project_id: project.id,
          name: 'drop_actors',
          query: 'drop table films;',
        },
        inputResponses: {
          confirm_destructive: { action: 'accept', content: {} },
        },
        requestState: first.requestState,
      })) as CallToolResult | InputRequiredResult;

      if (isInputRequiredResult(second)) {
        throw new Error('expected a CallToolResult');
      }
      expect(second.content).toContainEqual({
        type: 'text',
        text: 'Request state arguments do not match the current arguments.',
      });
      expect(second.structuredContent).toEqual({ status: 'error' });
      expect(second.isError).toBe(true);
      expect(applyMigration).not.toHaveBeenCalled();
    });

    test('form-capable client: non-destructive migration applies without elicitation', async () => {
      const { client, platform } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
      });
      const project = await createActiveProject();
      const applyMigration = vi.spyOn(platform.database!, 'applyMigration');

      await client.callTool({
        name: 'apply_migration',
        arguments: {
          project_id: project.id,
          name: 'create_films',
          query: 'create table films (id bigint);',
        },
      });

      expect(applyMigration).toHaveBeenCalledOnce();
    });
  });
});
