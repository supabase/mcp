import { ACCESS_TOKEN, API_URL, createProjectFixture } from '../test/mocks.js';
import { expectTerminalResult } from '../test/confirmation-results.js';
import {
  callModernTool,
  captureToolErrors,
  createServerHarness,
} from '../test/server-harness.js';
import { createSupabaseApiPlatform } from './platform/api-platform.js';
import type { SupabaseMcpServerOptions } from './server.js';
import {
  regexClassifier,
  SqlClassifierUnavailableError,
  type SqlConfirmationClassification,
  type SqlConfirmationClassifier,
  withFallback,
} from './sql-confirmation.js';
import { isInputRequiredResult } from '@modelcontextprotocol/client';
import type {
  CallToolRequestParams,
  CallToolResult,
  ClientCapabilities,
  InputRequiredResult,
} from '@modelcontextprotocol/client';
import { HttpResponse, http } from 'msw';
import { setImmediate } from 'node:timers/promises';
import { inspect } from 'node:util';
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

  test('list tables returns columns in ordinal position order after ALTER COLUMN', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table people (id integer, email text, name text, age integer);
      alter table people alter column email set not null;
      alter table people alter column id set default 0;
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const peopleTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.people'
    );
    expect(peopleTable.columns.map((c: { name: string }) => c.name)).toEqual([
      'id',
      'email',
      'name',
      'age',
    ]);
  });

  test('list tables returns the check expression for NOT VALID and NO INHERIT constraints', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table checks (a integer, b integer, c integer);
      alter table checks add constraint a_positive check (a > 0) not valid;
      alter table checks add constraint b_positive check (b > 0) no inherit;
      alter table checks add constraint c_positive check (c > 0);
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const checksTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.checks'
    );
    expect(
      checksTable.columns.map((c: { name: string; check?: string }) => [
        c.name,
        c.check,
      ])
    ).toEqual([
      ['a', 'a > 0'],
      ['b', 'b > 0'],
      ['c', 'c > 0'],
    ]);
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

  test('primary_keys follows key order and excludes INCLUDE columns', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table membership (
        org_id int not null,
        user_id int not null,
        primary key (user_id, org_id)
      );
      create table inc (a int not null, b int not null);
      create unique index inc_pk_idx on inc (a) include (b);
      alter table inc add constraint inc_pk primary key using index inc_pk_idx;
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const primaryKeys = (name: string) =>
      result.tables.find((t: { name: string }) => t.name === name).primary_keys;

    expect(primaryKeys('public.membership')).toEqual(['user_id', 'org_id']);
    expect(primaryKeys('public.inc')).toEqual(['a']);
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

  test('partition clones of an FK are not reported as separate constraints', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table orders (
        id int primary key
      ) partition by hash (id);
      create table orders_p0 partition of orders
        for values with (modulus 2, remainder 0);
      create table orders_p1 partition of orders
        for values with (modulus 2, remainder 1);
      create table order_items (
        order_id int references orders (id)
      );

      create table users (
        id int primary key
      );
      create table tags (
        id int primary key
      );
      create table events (
        user_id int references users (id),
        tag_id int,
        created_at date
      ) partition by range (created_at);
      create table events_2025 partition of events
        for values from ('2025-01-01') to ('2026-01-01');
      create table events_2026 partition of events
        for values from ('2026-01-01') to ('2027-01-01');
      alter table events_2025
        add constraint events_2025_tag_fk
          foreign key (tag_id) references tags (id);
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const fks = (name: string) =>
      result.tables.find((t: { name: string }) => t.name === name)
        .foreign_key_constraints;

    const orderItemsFk = {
      name: 'order_items_order_id_fkey',
      source_table: 'public.order_items',
      source_columns: ['order_id'],
      target_table: 'public.orders',
      target_columns: ['id'],
    };
    const eventsFk = {
      name: 'events_user_id_fkey',
      source_table: 'public.events',
      source_columns: ['user_id'],
      target_table: 'public.users',
      target_columns: ['id'],
    };
    const partitionFk = {
      name: 'events_2025_tag_fk',
      source_table: 'public.events_2025',
      source_columns: ['tag_id'],
      target_table: 'public.tags',
      target_columns: ['id'],
    };

    expect(fks('public.order_items')).toEqual([orderItemsFk]);
    expect(fks('public.orders')).toEqual([orderItemsFk]);
    expect(fks('public.orders_p0')).toBeUndefined();
    expect(fks('public.orders_p1')).toBeUndefined();

    expect(fks('public.events')).toEqual([eventsFk]);
    expect(fks('public.users')).toEqual([eventsFk]);
    expect(fks('public.events_2025')).toEqual([partitionFk]);
    expect(fks('public.tags')).toEqual([partitionFk]);
    expect(fks('public.events_2026')).toBeUndefined();
  });

  test('partitions are marked with their immediate parent', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db.exec(`
      create table events (
        region text,
        created_at date
      ) partition by range (created_at);
      create table events_2025 partition of events
        for values from ('2025-01-01') to ('2026-01-01')
        partition by list (region);
      create table events_2025_eu partition of events_2025
        for values in ('eu');
      create schema archive;
      create table archive.events_2024 partition of events
        for values from ('2024-01-01') to ('2025-01-01');

      create table logs (
        id int
      );
      create table logs_2025 () inherits (logs);
    `);

    for (const verbose of [false, true]) {
      const result = await callTool({
        name: 'list_tables',
        arguments: {
          project_id: project.id,
          schemas: ['public', 'archive'],
          verbose,
        },
      });

      const partitionOf = (name: string) =>
        result.tables.find((t: { name: string }) => t.name === name)
          .partition_of;

      expect(partitionOf('public.events')).toBeUndefined();
      expect(partitionOf('public.events_2025')).toBe('public.events');
      expect(partitionOf('public.events_2025_eu')).toBe('public.events_2025');
      expect(partitionOf('archive.events_2024')).toBe('public.events');
      expect(partitionOf('public.logs')).toBeUndefined();
      expect(partitionOf('public.logs_2025')).toBeUndefined();
    }
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
      expect.arrayContaining([
        expect.objectContaining({ name: 'public.test_1' }),
      ])
    );
  });

  test('listing all tables excludes system schemas', async () => {
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

    // PGlite has no TimescaleDB, so create a table in its internal schema;
    // without one, asserting that schema is absent would pass vacuously.
    await project.db.exec('create schema _timescaledb_internal;');
    await project.db.exec(
      'create table _timescaledb_internal.test_3 (id serial primary key);'
    );

    // Omitting `schemas` defaults to ["public"]; an empty array lists every
    // schema except the system schemas, which is the path under test.
    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: [],
      },
    });

    // `list_tables` returns `{ tables }`, and each table's schema is part of
    // its qualified `name` (e.g. `public.test_1`), so assert on those names.
    const tableNames: string[] = result.tables.map(
      (table: { name: string }) => table.name
    );

    // Guard against a vacuous pass: user tables from every schema are listed.
    expect(tableNames).toEqual(
      expect.arrayContaining(['public.test_1', 'test.test_2'])
    );

    // `list_tables` only selects ordinary and partitioned tables, so TOAST
    // tables never appear and the `pg_toast` check below cannot fail.
    for (const schema of [
      'pg_catalog',
      'information_schema',
      'pg_toast',
      '_timescaledb_internal',
    ]) {
      expect(
        tableNames.filter((name) => name.startsWith(`${schema}.`))
      ).toEqual([]);
    }
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

  // Real Management API body for a ref that fails zProjectRef (AI-1425).
  const malformedRefMessage = 'ref: ref must be exactly 20 characters long';
  const malformedRefHint =
    "Copy the ref exactly as returned by list_projects (id) or list_branches (project_ref), depending on whether you're working with the main project or a branch; do not retype or shorten it.";

  test.each([
    ...projectScopedDbTools.filter(({ tool }) =>
      ['execute_sql', 'apply_migration'].includes(tool)
    ),
    {
      tool: 'get_project',
      method: 'get',
      endpoint: '/v1/projects/:projectId',
      args: (projectId: string) => ({ id: projectId }),
    },
  ] as const)(
    'malformed ref for $tool tells the agent to re-copy it',
    async ({ tool, method, endpoint, args }) => {
      const { callTool } = await setup();

      harness.mockServer?.use(
        http[method](`${API_URL}${endpoint}`, () =>
          HttpResponse.json({ message: malformedRefMessage }, { status: 400 })
        )
      );

      await expect(
        callTool({ name: tool, arguments: args('abcdefghijklmnopqrs') })
      ).rejects.toThrow(`${malformedRefMessage}. ${malformedRefHint}`);
    }
  );

  test('other 400 errors are not given the ref hint', async () => {
    const { callTool } = await setup();

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    harness.mockServer?.use(
      http.post(`${API_URL}/v1/projects/:projectId/database/query`, () =>
        HttpResponse.json(
          { message: 'query: Invalid input: expected string' },
          { status: 400 }
        )
      )
    );

    const error = await callTool({
      name: 'execute_sql',
      arguments: { project_id: project.id, query: 'select 1;' },
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(malformedRefHint);
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

        // Regression: the decline message is missing from either result
        // channel, or names the other SQL tool.
        expectTerminalResult(
          enabledResult,
          'declined',
          {
            execute_sql: 'SQL execution was declined.',
            apply_migration: 'Migration was declined.',
          }[enabledTool]
        );
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

      // Regression: the decline message is missing from either result channel.
      expectTerminalResult(result, 'declined', 'SQL execution was declined.');
      expect(executeSql).not.toHaveBeenCalled();
    });

    test('form-capable client: only EXPLAIN ANALYZE elicits', async () => {
      const { client, platform } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'decline',
      });
      const project = await createActiveProject();
      await project.db.exec('create table films (id int)');
      const executeSql = vi.spyOn(platform.database!, 'executeSql');

      // A declined elicitation would end the call before execution.
      const explain = await client.callTool({
        name: 'execute_sql',
        arguments: {
          project_id: project.id,
          query:
            "EXPLAIN (ANALYZE FALSE, FORMAT JSON) SELECT '...; DELETE FROM fictional_table_only_in_literal;'::text",
        },
      });
      expect(explain.isError).toBeFalsy();
      expect(executeSql).toHaveBeenCalledOnce();

      const analyze = await client.callTool({
        name: 'execute_sql',
        arguments: {
          project_id: project.id,
          query: 'EXPLAIN ANALYZE DELETE FROM films;',
        },
      });
      expectTerminalResult(analyze, 'declined', 'SQL execution was declined.');
      expect(executeSql).toHaveBeenCalledOnce();
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
        // Regression: the decline message is missing from either result channel.
        expectTerminalResult(result, 'declined', 'SQL execution was declined.');
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
      // Regression: the mismatch error is missing from either result channel.
      expectTerminalResult(
        second,
        'error',
        'Request state arguments do not match the current arguments.'
      );
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

      // Regression: the decline message is missing from either result channel.
      expectTerminalResult(result, 'declined', 'Migration was declined.');
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
      // Regression: the mismatch error is missing from either result channel.
      expectTerminalResult(
        second,
        'error',
        'Request state arguments do not match the current arguments.'
      );
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

  describe('injected SQL confirmation classifier', () => {
    const SQL_TOOLS = ['execute_sql', 'apply_migration'] as const;
    type SqlTool = (typeof SQL_TOOLS)[number];
    type SetupOverrides = {
      clientCapabilities?: ClientCapabilities;
      readOnly?: boolean;
      enabledTools?: readonly SqlTool[];
      onToolCall?: SupabaseMcpServerOptions['onToolCall'];
    };

    async function setupWithClassifier(
      classifier: SqlConfirmationClassifier,
      overrides: SetupOverrides = {}
    ) {
      const { client, platform } = await setupModern({
        clientCapabilities: overrides.clientCapabilities ?? FORM_CAPABLE,
        readOnly: overrides.readOnly,
        onToolCall: overrides.onToolCall,
        elicitation: {
          requestState: ELICITATION_REQUEST_STATE,
          confirmation: {
            ...COST_CONFIRMATION,
            ...(overrides.enabledTools && {
              enabledTools: overrides.enabledTools,
            }),
            classifier,
          },
        },
      });
      const executeSql = vi
        .spyOn(platform.database!, 'executeSql')
        .mockResolvedValue([]);
      const applyMigration = vi
        .spyOn(platform.database!, 'applyMigration')
        .mockResolvedValue(undefined);
      const call = (tool: SqlTool, query: string, signal?: AbortSignal) =>
        client.request(
          {
            method: 'tools/call',
            params: {
              name: tool,
              arguments: {
                project_id: 'test-project',
                query,
                ...(tool === 'apply_migration' && { name: 'classified' }),
              },
            },
          },
          { allowInputRequired: true, signal }
        ) as Promise<CallToolResult | InputRequiredResult>;
      const resend = (
        tool: SqlTool,
        query: string,
        first: InputRequiredResult,
        action?: 'accept' | 'decline' | 'cancel'
      ) =>
        callModernTool(client, {
          name: tool,
          arguments: {
            project_id: 'test-project',
            query,
            ...(tool === 'apply_migration' && { name: 'classified' }),
          },
          requestState: first.requestState,
          ...(action && {
            inputResponses: {
              confirm_destructive:
                action === 'accept' ? { action, content: {} } : { action },
            },
          }),
        }) as Promise<CallToolResult | InputRequiredResult>;
      return { client, call, resend, executeSql, applyMigration };
    }

    // Stand-ins for a classifier's own error. Neither may reach the client.
    const PRIVATE_MESSAGE = 'PRIVATE_CLASSIFIER_MESSAGE';
    const PRIVATE_NAME = 'PRIVATE_CLASSIFIER_NAME';
    // Stand-in for text a classifier puts in a result outside the contract.
    const PRIVATE_RESULT = 'PRIVATE_CLASSIFIER_RESULT';
    const privateError = () =>
      Object.assign(new Error(PRIVATE_MESSAGE), { name: PRIVATE_NAME });

    /** The `error` of a failed tool call's `{ "error": { name, message } }` text. */
    function toolError(result: CallToolResult | InputRequiredResult) {
      if (isInputRequiredResult(result)) {
        throw new Error('expected a CallToolResult');
      }
      const [content] = result.content;
      if (content?.type !== 'text') {
        throw new Error('expected a text result');
      }
      return (JSON.parse(content.text) as { error?: { name?: unknown } }).error;
    }

    test.each(SQL_TOOLS)(
      '%s accepted retry executes original SQL when classification is unavailable',
      async (tool) => {
        let classification: SqlConfirmationClassification = 'destructive';
        const { client, executeSql, applyMigration } =
          await setupWithClassifier(async () => classification);
        const query = '-- preserve this comment\nDROP TABLE films;';
        const args = {
          project_id: 'test-project',
          query,
          ...(tool === 'apply_migration' && { name: 'drop_films' }),
        };
        try {
          const first = await callModernTool(client, {
            name: tool,
            arguments: args,
          });
          if (!isInputRequiredResult(first)) {
            throw new Error('expected an issued SQL confirmation');
          }
          expect(executeSql).not.toHaveBeenCalled();
          expect(applyMigration).not.toHaveBeenCalled();
          // The first call, the unanswered resend and a decline or cancel
          // under a failing classifier have their own tests: the outcome
          // table below and 'keeps staged $action final' in
          // observation-sql.test.ts.
          classification = { failure: 'unavailable' };

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
          await client.close();
        }
      }
    );

    test.each(SQL_TOOLS)(
      '%s uses the injected classifier instead of the regex',
      async (tool) => {
        const { call, executeSql, applyMigration } = await setupWithClassifier(
          async (sql) => (sql === 'select 1' ? 'destructive' : undefined)
        );

        expect(isInputRequiredResult(await call(tool, 'select 1'))).toBe(true);
        expect(executeSql).not.toHaveBeenCalled();
        expect(applyMigration).not.toHaveBeenCalled();

        const cleared = await call(tool, 'DROP TABLE films;');
        expect(isInputRequiredResult(cleared)).toBe(false);
        expect((cleared as CallToolResult).isError).not.toBe(true);
        expect(
          tool === 'execute_sql' ? executeSql : applyMigration
        ).toHaveBeenCalledOnce();
      }
    );

    // One row per classifier outcome the tools treat differently. The SQL is
    // one the regex clears, so only the injected classifier can stop it.
    type Outcome = 'asks for confirmation' | 'stops with an error';
    type OutcomeRow = {
      classifier: string;
      classify: SqlConfirmationClassifier;
      // No first-call outcome for `undefined`: it runs the SQL, which 'uses
      // the injected classifier instead of the regex' proves.
      firstCall?: Outcome;
      unansweredResend: Outcome;
      /** Text from the classifier's own error, which must not reach the client. */
      private?: readonly string[];
    };
    const returning = (value: unknown) =>
      (async () => value) as unknown as SqlConfirmationClassifier;
    const asks = (label: string, value: unknown): OutcomeRow => ({
      classifier: `returns ${label}`,
      classify: returning(value),
      firstCall: 'asks for confirmation',
      unansweredResend: 'asks for confirmation',
    });
    const stops = (
      classifier: string,
      classify: SqlConfirmationClassifier,
      privateText?: readonly string[]
    ): OutcomeRow => ({
      classifier,
      classify,
      firstCall: 'stops with an error',
      unansweredResend: 'stops with an error',
      private: privateText,
    });
    const CLASSIFIER_OUTCOMES: readonly OutcomeRow[] = [
      {
        classifier: 'returns undefined',
        classify: returning(undefined),
        // Once asked, only an accept runs the SQL.
        unansweredResend: 'asks for confirmation',
      },
      asks('destructive', 'destructive'),
      asks('do-heuristic', 'do-heuristic'),
      asks('unclassified', 'unclassified'),
      asks('an oversized failure', { failure: 'oversized' }),
      stops(
        'returns an unavailable failure',
        returning({ failure: 'unavailable' })
      ),
      stops('returns a timeout failure', returning({ failure: 'timeout' })),
      stops('returns a crashed failure', returning({ failure: 'crashed' })),
      // Results outside the contract, for example one that crossed IPC.
      stops('returns null', returning(null)),
      stops('returns false', returning(false)),
      // Text the classifier puts in a result is as private as its error.
      stops('returns an unknown reason', returning(PRIVATE_RESULT), [
        PRIVATE_RESULT,
      ]),
      stops(
        'returns an unknown failure kind',
        returning({ failure: PRIVATE_RESULT }),
        [PRIVATE_RESULT]
      ),
      stops(
        'returns a failure with extra keys',
        returning({ failure: 'oversized', reason: 'x' })
      ),
      // Results whose inspection throws. `then` stays readable, so the
      // classifier's promise resolves with the value instead of rejecting.
      stops(
        'returns an object whose failure getter throws',
        returning({
          get failure(): never {
            throw privateError();
          },
        }),
        [PRIVATE_MESSAGE, PRIVATE_NAME]
      ),
      stops(
        'returns a proxy whose traps throw',
        returning(
          new Proxy(
            {},
            {
              get(_target, key) {
                if (key === 'then') return undefined;
                throw privateError();
              },
              has() {
                throw privateError();
              },
              ownKeys() {
                throw privateError();
              },
              getOwnPropertyDescriptor() {
                throw privateError();
              },
              getPrototypeOf() {
                throw privateError();
              },
            }
          )
        ),
        [PRIVATE_MESSAGE, PRIVATE_NAME]
      ),
      // A classifier in this process can resolve with a live object whose
      // `failure` changes between reads: a valid kind for the first reads,
      // then the classifier's own text. One row per number of valid reads, so
      // no read position can pass that text on. The kind is `timeout`, which
      // `withFallback` passes through, and the regex clears this SQL, so a
      // fallback that answered instead would run it.
      ...Array.from({ length: 13 }, (_, validReads) => {
        const classify = (async () => {
          let reads = 0;
          return {
            get failure() {
              reads += 1;
              return reads <= validReads ? 'timeout' : PRIVATE_RESULT;
            },
          };
        }) as unknown as SqlConfirmationClassifier;
        const label = `returns a failure whose kind changes after ${validReads} reads`;
        return [
          stops(label, classify, [PRIVATE_RESULT]),
          stops(
            `${label}, through withFallback`,
            withFallback(classify, regexClassifier),
            [PRIVATE_RESULT]
          ),
        ];
      }).flat(),
      stops(
        'rejects',
        async () => {
          throw privateError();
        },
        [PRIVATE_MESSAGE, PRIVATE_NAME]
      ),
      stops(
        'throws synchronously',
        () => {
          throw privateError();
        },
        [PRIVATE_MESSAGE, PRIVATE_NAME]
      ),
      // Only `withFallback` reads this error; on its own it is one more rejection.
      stops(
        'rejects with SqlClassifierUnavailableError',
        async () => {
          throw new SqlClassifierUnavailableError(PRIVATE_MESSAGE);
        },
        [PRIVATE_MESSAGE, 'SqlClassifierUnavailableError']
      ),
      stops(
        'rejects with a string',
        async () => {
          throw PRIVATE_MESSAGE;
        },
        [PRIVATE_MESSAGE]
      ),
    ];

    describe.each(SQL_TOOLS)('%s', (tool) => {
      describe.each([
        ['first call', 'firstCall'],
        ['unanswered resend', 'unansweredResend'],
      ] as const)('on the %s', (_path, key) => {
        test.each(
          CLASSIFIER_OUTCOMES.flatMap((row) => {
            const outcome = row[key];
            return outcome ? [[outcome, row.classifier, row] as const] : [];
          })
        )(
          '%s when the classifier %s',
          async (outcome, _classifier, { classify, private: privateText }) => {
            let current: SqlConfirmationClassifier = async () => 'destructive';
            const { errors, onToolCall } = captureToolErrors();
            const { call, resend, executeSql, applyMigration } =
              await setupWithClassifier(
                (sql, options) => current(sql, options),
                { onToolCall }
              );

            let result: CallToolResult | InputRequiredResult;
            if (key === 'firstCall') {
              current = classify;
              result = await call(tool, 'select 1');
            } else {
              const first = await call(tool, 'select 1');
              if (!isInputRequiredResult(first)) {
                throw new Error('expected an issued SQL confirmation');
              }
              current = classify;
              result = await resend(tool, 'select 1', first);
            }

            if (outcome === 'asks for confirmation') {
              if (!isInputRequiredResult(result)) {
                throw new Error('expected an input_required result');
              }
              expect(result.requestState).toEqual(expect.any(String));
              expect(result.inputRequests?.confirm_destructive).toBeDefined();
            } else {
              expect(isInputRequiredResult(result)).toBe(false);
              expect((result as CallToolResult).isError).toBe(true);
              // Hosts match every classification failure by this one name.
              expect(toolError(result)?.name).toBe('SqlClassifierCallError');
              const wire = JSON.stringify(result);
              for (const text of privateText ?? []) {
                expect(wire).not.toContain(text);
              }
            }
            expect(executeSql).not.toHaveBeenCalled();
            expect(applyMigration).not.toHaveBeenCalled();

            if (outcome === 'stops with an error') {
              // What the host gets through `onToolCall`, before the error is
              // serialized: the package's own error and nothing of the
              // classifier's, so nothing raw reaches host logs or spans.
              expect(errors).toHaveLength(1);
              const [hostError] = errors as [Error];
              expect(hostError.name).toBe('SqlClassifierCallError');
              expect(hostError.cause).toBeUndefined();
              const hostView = inspect(hostError, {
                showHidden: true,
                depth: null,
              });
              for (const text of privateText ?? []) {
                expect(hostView).not.toContain(text);
              }
            }
          }
        );
      });
    });

    // One keyword per prompt, from the approved wording. A keyword and not
    // the sentence, so a reworded prompt still passes.
    const PROMPT_KEYWORDS = {
      destructive: 'DROP',
      'do-heuristic': 'DO block',
      unclassified: 'syntax',
      oversized: 'too large',
      'flagged earlier': 'earlier',
    } as const;
    type Prompt = keyof typeof PROMPT_KEYWORDS;

    test.each(SQL_TOOLS)(
      '%s gives each confirmation reason its own first prompt line',
      async (tool) => {
        let classification: SqlConfirmationClassification;
        const { call, resend } = await setupWithClassifier(
          async () => classification
        );
        const firstLineOf = (
          prompt: Prompt,
          result: CallToolResult | InputRequiredResult
        ) => {
          if (!isInputRequiredResult(result)) {
            throw new Error(`expected a confirmation for ${prompt}`);
          }
          const params = result.inputRequests?.confirm_destructive?.params;
          const message = params && 'message' in params ? params.message : '';
          return message.split('\n')[0] ?? '';
        };

        const firstLines: string[] = [];
        const keywordsFound: Partial<Record<Prompt, string[]>> = {};
        const record = (prompt: Prompt, firstLine: string) => {
          firstLines.push(firstLine);
          keywordsFound[prompt] = Object.values(PROMPT_KEYWORDS).filter(
            (keyword) => firstLine.includes(keyword)
          );
        };

        let issued: CallToolResult | InputRequiredResult | undefined;
        for (const [prompt, reason] of [
          ['destructive', 'destructive'],
          ['do-heuristic', 'do-heuristic'],
          ['unclassified', 'unclassified'],
          ['oversized', { failure: 'oversized' }],
        ] as const) {
          classification = reason;
          issued = await call(tool, 'select 1');
          record(prompt, firstLineOf(prompt, issued));
        }
        // An unanswered resend that the classifier now clears still asks,
        // with a prompt of its own.
        if (!issued || !isInputRequiredResult(issued)) {
          throw new Error('expected an issued SQL confirmation');
        }
        classification = undefined;
        record(
          'flagged earlier',
          firstLineOf('flagged earlier', await resend(tool, 'select 1', issued))
        );

        expect(firstLines).not.toContain('');
        // Regression: a reason falls through to another reason's prompt.
        expect(firstLines).toEqual([...new Set(firstLines)]);
        // Regression: two reasons swap their prompts. Each first line holds
        // its own keyword and no other prompt's keyword.
        expect(keywordsFound).toEqual({
          destructive: ['DROP'],
          'do-heuristic': ['DO block'],
          unclassified: ['syntax'],
          oversized: ['too large'],
          'flagged earlier': ['earlier'],
        });
      }
    );

    test.each(SQL_TOOLS)(
      '%s runs once on an accepted resend after an oversized prompt, though the classifier now throws',
      async (tool) => {
        // An accepted resend does not classify again, so a classifier that
        // fails by then cannot block it.
        const classifier = vi
          .fn<SqlConfirmationClassifier>()
          .mockResolvedValueOnce({ failure: 'oversized' })
          .mockRejectedValue(privateError());
        const { call, resend, executeSql, applyMigration } =
          await setupWithClassifier(classifier);

        const first = await call(tool, 'select 1');
        if (!isInputRequiredResult(first)) {
          throw new Error('expected an issued SQL confirmation');
        }
        expect(executeSql).not.toHaveBeenCalled();
        expect(applyMigration).not.toHaveBeenCalled();
        classifier.mockClear();

        const accepted = await resend(tool, 'select 1', first, 'accept');
        expect(isInputRequiredResult(accepted)).toBe(false);
        expect((accepted as CallToolResult).isError).not.toBe(true);
        expect(
          tool === 'execute_sql' ? executeSql : applyMigration
        ).toHaveBeenCalledOnce();
        // Regression: the resend classifies again and drops the result.
        expect(classifier).not.toHaveBeenCalled();
      }
    );

    const BYPASSES = {
      'confirmation is not enabled for the tool': (tool) => ({
        enabledTools: SQL_TOOLS.filter((other) => other !== tool),
      }),
      'the client cannot elicit': () => ({ clientCapabilities: {} }),
      'the server is read-only': () => ({ readOnly: true }),
    } satisfies Record<string, (tool: SqlTool) => SetupOverrides>;
    type Bypass = keyof typeof BYPASSES;

    test.each(
      SQL_TOOLS.flatMap((tool) =>
        (Object.keys(BYPASSES) as Bypass[]).map(
          (bypass) => [tool, bypass] as const
        )
      )
    )('%s does not call the classifier when %s', async (tool, bypass) => {
      // Regression: the tool classifies before it knows a confirmation can
      // apply, so a slow or failing classifier holds up calls it cannot gate.
      const classifier = vi.fn<SqlConfirmationClassifier>(async () => {
        throw privateError();
      });
      const { call, executeSql, applyMigration } = await setupWithClassifier(
        classifier,
        BYPASSES[bypass](tool)
      );

      const result = await call(tool, 'DROP TABLE films;');

      expect(classifier).not.toHaveBeenCalled();
      expect(isInputRequiredResult(result)).toBe(false);
      if (tool === 'apply_migration' && bypass === 'the server is read-only') {
        // A read-only server refuses every migration.
        expect(applyMigration).not.toHaveBeenCalled();
      } else {
        expect((result as CallToolResult).isError).not.toBe(true);
        expect(
          tool === 'execute_sql' ? executeSql : applyMigration
        ).toHaveBeenCalledOnce();
      }
    });

    test.each(
      SQL_TOOLS.flatMap((tool) =>
        (['resolves', 'rejects'] as const).map(
          (settles) => [tool, settles] as const
        )
      )
    )(
      '%s does not run the SQL when the request aborts during classification and the classifier then %s',
      async (tool, settles) => {
        let classifierSignal: AbortSignal | undefined;
        let classified = false;
        const { errors, onToolCall } = captureToolErrors();
        const { call, executeSql, applyMigration } = await setupWithClassifier(
          async (_sql, { signal }) => {
            classifierSignal = signal;
            // Executor form: the package's lib target predates withResolvers.
            await new Promise((resolve) =>
              signal.addEventListener('abort', resolve, { once: true })
            );
            classified = true;
            if (settles === 'rejects') throw privateError();
            return undefined;
          },
          { onToolCall }
        );
        const controller = new AbortController();

        const request = call(tool, 'select 1', controller.signal);
        await vi.waitFor(() => expect(classifierSignal).toBeDefined());
        expect(classifierSignal?.aborted).toBe(false);
        controller.abort();
        await expect(request).rejects.toThrow();
        await vi.waitFor(() => expect(classified).toBe(true));
        // The rest of the handler runs on microtasks, which drain first.
        await setImmediate();
        expect(executeSql).not.toHaveBeenCalled();
        expect(applyMigration).not.toHaveBeenCalled();
        // The abort wins: the host gets the cancelled request's own error,
        // not a classification failure built from the late rejection.
        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).name).not.toBe('SqlClassifierCallError');
        expect(
          inspect(errors[0], { showHidden: true, depth: null })
        ).not.toContain(PRIVATE_MESSAGE);
      }
    );
  });
});
