import { createAppsDir, surfaceScript, surfaceStyle } from '../test/apps.js';
import {
  ACCESS_TOKEN,
  API_URL,
  createOrganization,
  createProjectFixture,
} from '../test/mocks.js';
import { expectTerminalResult } from '../test/confirmation-results.js';
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
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataOperations, parseUntrustedJson } from './apps/contracts.js';
import { getAppResources } from './tools/apps/index.js';
import { HttpResponse, http } from 'msw';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const harness = createServerHarness();

beforeEach(() => harness.reset());
afterEach(() => harness.close());

const UI_CAPABILITIES = {
  extensions: {
    'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
  },
} as ClientCapabilities;

/** What a view reads from a tool result, as the MCP Apps data port decodes it. */
function toolPayload(result: {
  isError?: unknown;
  structuredContent?: unknown;
  content?: unknown;
}) {
  const [first] = (result.content ?? []) as { text?: string }[];
  if (result.isError) throw new Error(first?.text ?? 'Tool error');
  if (result.structuredContent !== undefined) return result.structuredContent;
  return parseUntrustedJson(first?.text ?? '');
}

describe('MCP Apps', () => {
  let appsBuild: Awaited<ReturnType<typeof createAppsDir>>;
  beforeAll(async () => {
    appsBuild = await createAppsDir();
  });
  afterAll(() => appsBuild.cleanup());
  const apps = () => ({ assets: { dir: appsBuild.dir } });
  // These tests stand in for an MCP Apps host unless they say otherwise.
  const setup: typeof harness.setup = (options = {}) =>
    harness.setup({ clientCapabilities: UI_CAPABILITIES, ...options });
  async function fixture(
    options: { readOnly?: boolean; scoped?: boolean; appLink?: boolean } = {}
  ) {
    const { project } = await createProjectFixture();
    await project.db.exec(`
      create table public.browser_rows (tenant text, id bigint, label text, amount numeric, payload jsonb, primary key (tenant, id));
      alter table public.browser_rows enable row level security;
      create policy browser_read on public.browser_rows for select to supabase_read_only_role using (true);
      insert into public.browser_rows values ('a', 9007199254740993, 'First', 12345678901234567890.12345, '{"ok":true}'), ('b', 9007199254740993, 'Second', 2, null);
    `);
    const { client } = await setup({
      apps: {
        ...apps(),
        ...(options.appLink
          ? {
              appLinkBase:
                'codex://plugins/supabase@supabase-local/app/open_projects',
            }
          : {}),
      },
      readOnly: options.readOnly,
      projectId: options.scoped ? project.id : undefined,
    });
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) return { error: result.content };
      return (
        result.structuredContent ??
        JSON.parse((result.content[0] as { text: string }).text)
      );
    }
    const target = {
      project_id: project.id,
      schema: 'public',
      table: 'browser_rows',
    };
    return { project, client, call, target };
  }
  test('project issues open beside the conversation for the model', async () => {
    const { client, target } = await fixture({ scoped: true });
    const definition = (await client.listTools()).tools.find(
      (tool) => tool.name === 'open_issues_panel'
    );
    expect(definition).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: {
          resourceUri: 'ui://supabase/panel-v1',
          visibility: ['model', 'app'],
        },
      },
    });
    const result = await client.callTool({
      name: 'open_issues_panel',
      arguments: { project_id: target.project_id },
    });
    expect(result.isError).not.toBe(true);
    expect(result._meta?.['supabase/panel']).toMatchObject({
      panel: { view: 'issues', project_id: target.project_id },
    });
  });

  test('the project home opens beside the conversation for the model', async () => {
    const { client, target } = await fixture({ scoped: true });
    const definition = (await client.listTools()).tools.find(
      (tool) => tool.name === 'open_project_home_panel'
    );
    expect(definition).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: {
          resourceUri: 'ui://supabase/panel-v1',
          visibility: ['model', 'app'],
        },
      },
    });
    const result = await client.callTool({
      name: 'open_project_home_panel',
      arguments: { project_id: target.project_id },
    });
    expect(result.isError).not.toBe(true);
    expect(result._meta?.['supabase/panel']).toMatchObject({
      panel: { view: 'home', project_id: target.project_id },
    });
  });

  test('the database explorer opens beside the conversation for the model, starting at a table', async () => {
    const { client, target } = await fixture({ scoped: true });
    const definition = (await client.listTools()).tools.find(
      (tool) => tool.name === 'open_explorer_panel'
    );
    expect(definition).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: {
          resourceUri: 'ui://supabase/panel-v1',
          visibility: ['model', 'app'],
        },
      },
    });
    const result = await client.callTool({
      name: 'open_explorer_panel',
      arguments: target,
    });
    expect(result.isError).not.toBe(true);
    expect(result._meta?.['supabase/panel']).toMatchObject({
      panel: {
        view: 'explorer',
        project_id: target.project_id,
        schema: 'public',
        table: 'browser_rows',
      },
    });
  });

  test('row panels load the exact composite key privately and support conflict-safe edits', async () => {
    const { client, call, target } = await fixture({ scoped: true });
    const key = { tenant: 'a', id: '9007199254740993' };
    const definition = (await client.listTools()).tools.find(
      (tool) => tool.name === 'open_row_panel'
    );
    expect(definition).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: {
          resourceUri: 'ui://supabase/panel-v1',
          visibility: ['model', 'app'],
        },
      },
    });
    const result = await client.callTool({
      name: 'open_row_panel',
      arguments: { ...target, key },
    });
    expect(result.isError).not.toBe(true);
    expect(
      JSON.stringify({
        content: result.content,
        structuredContent: result.structuredContent,
      })
    ).not.toContain('First');
    expect(result._meta?.['supabase/panel']).toMatchObject({
      panel: {
        view: 'row',
        project_id: target.project_id,
        table: {
          name: target.table,
          primary_keys: ['tenant', 'id'],
          editable: true,
        },
        row: {
          ...key,
          label: 'First',
          amount: '12345678901234567890.12345',
          payload: { ok: true },
        },
      },
    });
    const edit = {
      ...target,
      key,
      values: { label: 'Saved' },
      previous: { label: 'First' },
    };
    expect(await call('app_update_row', edit)).not.toHaveProperty('error');
    expect(await call('app_read_row', { ...target, key })).toMatchObject({
      row: { ...key, label: 'Saved' },
    });
    expect(await call('app_update_row', edit)).toHaveProperty('error');
    expect(
      await call('app_read_row', {
        ...target,
        key: { ...key, tenant: 'b' },
      })
    ).toMatchObject({ row: { label: 'Second' } });
  });
  test('row launches reject incomplete, extra, missing and out-of-scope keys', async () => {
    const { call, target } = await fixture({ scoped: true });
    for (const name of ['open_row_panel', 'app_read_row']) {
      for (const key of [
        {},
        { id: '9007199254740993' },
        { tenant: null, id: '9007199254740993' },
        { tenant: 'a', id: '9007199254740993', label: 'First' },
        { tenant: 'missing', id: '9007199254740993' },
        { tenant: "a' OR true --", id: '9007199254740993' },
      ]) {
        expect(await call(name, { ...target, key })).toHaveProperty('error');
      }
      expect(
        await call(name, {
          ...target,
          project_id: 'other',
          key: { tenant: 'a', id: '9007199254740993' },
        })
      ).toHaveProperty('error');
    }
  });
  test('read-only row panels cannot save and tables without primary keys cannot launch', async () => {
    const { call, client, target, project } = await fixture({ readOnly: true });
    const key = { tenant: 'a', id: '9007199254740993' };
    const result = await client.callTool({
      name: 'open_row_panel',
      arguments: { ...target, key },
    });
    expect(result.isError).not.toBe(true);
    expect(result._meta?.['supabase/panel']).toMatchObject({
      panel: { table: { editable: false } },
    });
    expect(
      await call('app_update_row', {
        ...target,
        key,
        values: { label: 'Blocked' },
        previous: { label: 'First' },
      })
    ).toHaveProperty('error');
    await project.db.exec('create table public.no_key (id int)');
    expect(
      await call('open_row_panel', {
        ...target,
        table: 'no_key',
        key: { id: 1 },
      })
    ).toHaveProperty('error');
  });
  test('thread workspace accepts empty arguments and retains connection scope', async () => {
    const { project, client, call } = await fixture({
      scoped: true,
      readOnly: true,
    });
    const entry = (await client.listTools()).tools.find(
      (tool) => tool.name === 'open_workspace'
    );
    expect(entry).toMatchObject({
      title: 'Database workspace',
      _meta: {
        ui: { resourceUri: 'ui://supabase/projects-v1', visibility: ['app'] },
        'openai/ui': { entrypoints: [{ type: 'thread' }] },
      },
    });
    const opened = await call('open_workspace');
    expect(opened.projects.map((item: { id: string }) => item.id)).toEqual([
      project.id,
    ]);
    expect(opened.capabilities).toMatchObject({
      scopedProjectId: project.id,
      readOnly: true,
    });
  });
  test('each surface is its own resource with its own presentation', async () => {
    const { client } = await fixture();
    const resources = (await client.listResources()).resources;
    expect(resources.map((resource) => resource.uri)).toEqual([
      'ui://supabase/projects-v1',
      'ui://supabase/panel-v1',
      'ui://supabase/query-block-v1',
      'ui://supabase/project-card-v1',
    ]);
    for (const [uri, surface, mode, modes] of [
      ['ui://supabase/projects-v1', 'projects', 'fullscreen', ['fullscreen']],
      ['ui://supabase/panel-v1', 'panel', 'fullscreen', ['fullscreen']],
      [
        'ui://supabase/query-block-v1',
        'query-block',
        'inline',
        ['inline', 'fullscreen'],
      ],
      ['ui://supabase/project-card-v1', 'project-card', 'inline', ['inline']],
    ] as const) {
      const result = await client.readResource({ uri });
      expect(result.contents[0]).toMatchObject({
        text: expect.stringContaining(surfaceScript(surface)),
        mimeType: 'text/html;profile=mcp-app',
        _meta: {
          'openai/ui': {
            preferredDisplayMode: mode,
            availableDisplayModes: modes,
          },
        },
      });
    }
  });
  test.each(['open_sql_panel', 'show_query_block'])(
    '%s carries rows only in app metadata and keeps the sidebar unchanged',
    async (name) => {
      const { project, client } = await fixture({ scoped: true });
      const tools = (await client.listTools()).tools;
      expect(tools.find((tool) => tool.name === name)).toMatchObject({
        annotations: { readOnlyHint: true },
        _meta: {
          ui: {
            resourceUri:
              name === 'show_query_block'
                ? 'ui://supabase/query-block-v1'
                : 'ui://supabase/panel-v1',
            visibility: ['model', 'app'],
          },
          'openai/ui': {
            preferredModelDisplayMode:
              name === 'show_query_block' ? 'inline' : 'fullscreen',
          },
        },
      });
      const sql =
        'select label from public.browser_rows order by label desc limit 1';
      const result = await client.callTool({
        name,
        arguments: { project_id: project.id, title: 'Latest rows', sql },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        project_id: project.id,
        view: 'query',
        row_count: 1,
      });
      expect(
        JSON.stringify({
          content: result.content,
          structuredContent: result.structuredContent,
        })
      ).not.toContain('Second');
      expect(result._meta?.['supabase/panel']).toMatchObject({
        projects: [{ id: project.id }],
        panel: {
          project_id: project.id,
          view: 'query',
          title: 'Latest rows',
          ...(name === 'show_query_block' ? { surface: 'inline' } : {}),
          sql,
          result: { rows: [{ label: 'Second' }], sql, hasMore: false },
        },
      });
      const sidebar = await client.callTool({
        name: 'open_projects',
        arguments: {},
      });
      expect(sidebar.structuredContent).not.toHaveProperty('panel');
      expect(sidebar._meta).toBeUndefined();
    }
  );
  test.each(['open_sql_panel', 'show_query_block'])(
    '%s enforces project scope and cannot write even on a writable connection',
    async (name) => {
      const { project, client } = await fixture({ scoped: true });
      for (const sql of [
        'delete from public.browser_rows',
        'with removed as (delete from public.browser_rows returning *) select * from removed',
        'select 1; delete from public.browser_rows;',
      ]) {
        const result = await client.callTool({
          name,
          arguments: { project_id: project.id, sql },
        });
        expect(result.isError).toBe(true);
      }
      const wrongProject = await client.callTool({
        name,
        arguments: { project_id: 'other', sql: 'select 1' },
      });
      expect(wrongProject.isError).toBe(true);
      expect(
        (await project.db.query('select * from public.browser_rows')).rows
      ).toHaveLength(2);
    }
  );
  test.each(['open_sql_panel', 'show_query_block'])(
    '%s bounds results and works on read-only connections',
    async (name) => {
      const { project, client } = await fixture({ readOnly: true });
      const result = await client.callTool({
        name,
        arguments: {
          project_id: project.id,
          sql: 'select generate_series(1, 1001) as n',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        row_count: 1000,
        truncated: true,
      });
      const initial = result._meta?.['supabase/panel'] as any;
      expect(initial.panel.result.rows).toHaveLength(1000);
      expect(initial.capabilities.readOnly).toBe(true);
    }
  );
  test.each(['show_query_block', 'open_sql_panel'])(
    '%s forwards Studio chart settings without exposing result rows',
    async (name) => {
      const { project, client } = await fixture({ scoped: true });
      const display = {
        view: 'chart',
        chart: {
          type: 'line',
          x_column: 'day',
          y_series: ['revenue', 'orders'],
          cumulative: true,
          show_labels: true,
          scale: 'linear',
        },
      };
      const result = await client.callTool({
        name,
        arguments: {
          project_id: project.id,
          sql: 'select label as day, 10::numeric as revenue, 3 as orders from public.browser_rows order by label',
          display,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result._meta?.['supabase/panel']).toMatchObject({
        panel: { display, result: { rows: expect.any(Array) } },
      });
      expect(
        JSON.stringify({
          content: result.content,
          structuredContent: result.structuredContent,
        })
      ).not.toContain('Second');
      for (const chart of [
        { ...display.chart, type: 'pie' },
        { ...display.chart, y_series: ['a', 'b', 'c', 'd'] },
        { ...display.chart, y_series: ['a', 'a'] },
      ]) {
        const invalid = await client.callTool({
          name,
          arguments: {
            project_id: project.id,
            sql: 'select 1',
            display: { view: 'chart', chart },
          },
        });
        expect(invalid.isError).toBe(true);
      }
    }
  );
  test.each(['show_query_block', 'open_sql_panel'])(
    '%s runs logs on a debugging-only connection and preserves its window and chart',
    async (name) => {
      const { project } = await createProjectFixture();
      const platform = createSupabaseApiPlatform({
        accessToken: ACCESS_TOKEN,
        apiUrl: API_URL,
      });
      const rows = Array.from({ length: 1001 }, (_, n) => ({
        timestamp: '2026-10-23T00:00:00Z',
        error_rate: n,
        private_label: 'private-log-value',
      }));
      const queryLogs = vi
        .fn()
        .mockResolvedValue({ result: rows, error: null });
      platform.debugging!.queryLogs = queryLogs;
      const database = vi.spyOn(platform.database!, 'executeSql');
      const { client } = await setup({
        apps: apps(),
        platform,
        projectId: project.id,
        features: ['debugging'],
        readOnly: true,
      });
      const window = {
        iso_timestamp_start: '2026-10-23T00:00:00Z',
        iso_timestamp_end: '2026-10-23T01:00:00Z',
      };
      const sql =
        'select timestamp, error_rate from logs order by timestamp limit 1001';
      const display = {
        view: 'chart',
        chart: {
          type: 'line',
          x_column: 'timestamp',
          y_series: ['error_rate'],
          show_labels: true,
        },
      };
      const args = {
        project_id: project.id,
        source: 'logs',
        sql,
        display,
        ...window,
      };
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(queryLogs).toHaveBeenCalledOnce();
      expect(queryLogs).toHaveBeenCalledWith(project.id, {
        sql,
        iso_timestamp_start: '2026-10-23T00:00:00.000Z',
        iso_timestamp_end: '2026-10-23T01:00:00.000Z',
      });
      expect(database).not.toHaveBeenCalled();
      expect(result._meta?.['supabase/panel']).toMatchObject({
        capabilities: { database: false, logQueries: true },
        panel: {
          source: 'logs',
          iso_timestamp_start: '2026-10-23T00:00:00.000Z',
          iso_timestamp_end: '2026-10-23T01:00:00.000Z',
          display,
          result: { truncated: true, rows: rows.slice(0, 1000) },
        },
      });
      expect(
        JSON.stringify({
          content: result.content,
          structuredContent: result.structuredContent,
        })
      ).not.toContain('private-log-value');
      for (const invalid of [
        { project_id: 'other' },
        { source: 'database' },
        { iso_timestamp_start: '2026-10-21T00:00:00Z' },
        { iso_timestamp_start: window.iso_timestamp_end },
        { iso_timestamp_start: 'not-a-date' },
      ]) {
        expect(
          (await client.callTool({ name, arguments: { ...args, ...invalid } }))
            .isError
        ).toBe(true);
      }
      expect(queryLogs).toHaveBeenCalledOnce();
      for (const response of [
        { error: { message: 'Invalid logs SQL' }, result: [] },
        { unexpected: [] },
      ]) {
        queryLogs.mockResolvedValueOnce(response);
        expect((await client.callTool({ name, arguments: args })).isError).toBe(
          true
        );
      }
      queryLogs.mockRejectedValueOnce(new Error('Logs access denied'));
      expect((await client.callTool({ name, arguments: args })).isError).toBe(
        true
      );
      queryLogs.mockResolvedValueOnce({ result: [] });
      const empty = await client.callTool({
        name,
        arguments: { project_id: project.id, source: 'logs', sql },
      });
      expect(empty.isError).not.toBe(true);
      const lastWindow = queryLogs.mock.calls.at(-1)![1];
      expect(
        Date.parse(lastWindow.iso_timestamp_end) -
          Date.parse(lastWindow.iso_timestamp_start)
      ).toBe(86400000);
      expect(empty.structuredContent).toMatchObject({
        source: 'logs',
        row_count: 0,
        truncated: false,
      });
      expect(database).not.toHaveBeenCalled();
    }
  );
  test('query blocks reject disabled log access without falling back to PostgreSQL', async () => {
    const { project } = await createProjectFixture();
    const platform = createSupabaseApiPlatform({
      accessToken: ACCESS_TOKEN,
      apiUrl: API_URL,
    });
    const queryLogs = vi.fn();
    platform.debugging!.queryLogs = queryLogs;
    const database = vi.spyOn(platform.database!, 'executeSql');
    const { client } = await setup({
      apps: apps(),
      platform,
      features: ['database'],
    });
    const result = await client.callTool({
      name: 'show_query_block',
      arguments: {
        project_id: project.id,
        source: 'logs',
        sql: 'select timestamp from logs limit 1',
      },
    });
    expect(result.isError).toBe(true);
    expect(queryLogs).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
  });
  test('views list notebooks through list_notebooks without cell contents, and the panel opens beside the conversation', async () => {
    const { project } = await createProjectFixture();
    const platform = createSupabaseApiPlatform({
      accessToken: ACCESS_TOKEN,
      apiUrl: API_URL,
    });
    const user = { id: 'user', username: 'ada', primary_email: null };
    const notebook = (id: string, favorite: boolean, updated_at: string) => ({
      id,
      name: `Notebook ${id}`,
      description: null,
      favorite,
      inserted_at: updated_at,
      updated_at,
      owner: user,
      updated_by: user,
      content: { cells: [{ sql: 'select secret' }] },
    });
    platform.notebooks!.listNotebooks = vi
      .fn()
      .mockResolvedValue([
        notebook('old', false, '2026-11-01T00:00:00Z'),
        notebook('new', false, '2026-11-10T00:00:00Z'),
        notebook('pinned', true, '2026-10-01T00:00:00Z'),
      ]);
    const { client } = await setup({
      apps: apps(),
      platform,
      projectId: project.id,
      features: ['notebooks'],
    });
    // Views read the model's own list_notebooks and keep only what the list shows.
    const listed = await client.callTool({
      name: 'list_notebooks',
      arguments: {},
    });
    const { notebooks } = dataOperations.listNotebooks.output.parse(
      toolPayload(listed)
    );
    expect(notebooks.map((item) => item.id)).toEqual(['old', 'new', 'pinned']);
    expect(JSON.stringify(notebooks)).not.toContain('select secret');
    expect(JSON.stringify(notebooks)).not.toContain('ada');
    expect(
      (await client.listTools()).tools.some(
        (tool) => tool.name === 'app_list_notebooks'
      )
    ).toBe(false);

    const opened = await client.callTool({
      name: 'open_notebooks_panel',
      arguments: { project_id: project.id },
    });
    expect(opened.isError).not.toBe(true);
    expect(opened._meta?.['supabase/panel']).toMatchObject({
      panel: { view: 'notebooks', project_id: project.id },
    });
  });
  test('logs panels launch without database or account-list access and filter sources and levels before limiting', async () => {
    const { project } = await createProjectFixture();
    const platform = createSupabaseApiPlatform({
      accessToken: ACCESS_TOKEN,
      apiUrl: API_URL,
    });
    const queryLogs = vi.fn().mockResolvedValue({ result: [] });
    platform.debugging!.queryLogs = queryLogs;
    const { client } = await setup({
      apps: apps(),
      platform,
      projectId: project.id,
      features: ['debugging'],
    });
    const result = await client.callTool({
      name: 'open_logs_panel',
      arguments: {
        project_id: project.id,
        source: 'edge_functions',
        level: 'error',
        minutes: 360,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result._meta?.['supabase/panel']).toMatchObject({
      capabilities: { database: false, logs: true },
      panel: {
        view: 'logs',
        settings: {
          source: 'edge_functions',
          level: 'error',
          minutes: 360,
          search: '',
        },
      },
    });
    expect(queryLogs).not.toHaveBeenCalled();
    await client.callTool({
      name: 'app_get_logs',
      arguments: {
        project_id: project.id,
        source: 'edge_functions',
        minutes: 360,
      },
    });
    expect(queryLogs).toHaveBeenCalledOnce();
    expect(queryLogs.mock.calls[0]![1].sql).toContain(
      "WHERE source IN ('function_edge_logs', 'function_logs') ORDER BY timestamp DESC LIMIT 100"
    );
    await client.callTool({
      name: 'app_get_logs',
      arguments: {
        project_id: project.id,
        source: 'edge_functions',
        level: 'error',
        minutes: 360,
      },
    });
    // Filters reuse the displayed level, which checks HTTP status (gateway,
    // auth and storage rows log INFO for 5xx) before severity_text.
    const errorSql: string = queryLogs.mock.calls[1]![1].sql;
    const levelSql = errorSql.match(
      /^SELECT .*?(\(CASE .+?END\)) AS level,/
    )![1]!;
    expect(levelSql).toContain("log_attributes['res.statusCode']");
    expect(levelSql.indexOf(">= 500 THEN 'error'")).toBeLessThan(
      levelSql.indexOf('severity_text')
    );
    expect(errorSql).toContain(
      `WHERE source IN ('function_edge_logs', 'function_logs') AND ${levelSql} = 'error' ORDER BY timestamp DESC LIMIT 100`
    );
    await client.callTool({
      name: 'app_get_logs',
      arguments: { project_id: project.id, level: 'warning' },
    });
    expect(queryLogs.mock.calls[2]![1].sql).toContain(
      `FROM logs WHERE ${levelSql} = 'warning' ORDER BY`
    );
    for (const args of [
      { project_id: 'other' },
      { project_id: project.id, source: "auth_logs'; drop table logs; --" },
      { project_id: project.id, level: "error'; drop table logs; --" },
    ]) {
      expect(
        (await client.callTool({ name: 'open_logs_panel', arguments: args }))
          .isError
      ).toBe(true);
    }
    expect(
      (
        await client.callTool({
          name: 'app_get_logs',
          arguments: { project_id: project.id, level: 'debug' },
        })
      ).isError
    ).toBe(true);
    expect(queryLogs).toHaveBeenCalledTimes(3);
    expect(
      (await client.listTools()).tools.some(
        (tool) => tool.name === 'open_sql_panel'
      )
    ).toBe(true);
  });
  test('composer mentions return bounded scoped metadata and navigable table links, never rows', async () => {
    const { project, client, call } = await fixture({
      scoped: true,
      appLink: true,
    });
    const entry = (await client.listTools()).tools.find(
      (tool) => tool.name === 'search_project_mentions'
    );
    expect(entry?._meta).toMatchObject({
      ui: { visibility: ['app'] },
      'openai/extensions': { 'mentions/search': {} },
    });
    const recent = await call('search_project_mentions', { query: '' });
    expect(recent.items).toHaveLength(1);
    expect(recent.items[0].description).toContain(project.id);
    const tables = await call('search_project_mentions', {
      query: 'browser_rows',
    });
    expect(tables.items).toHaveLength(1);
    const link = new URL(tables.items[0].uri);
    const route = new URL(
      link.searchParams.get('path')!,
      'https://example.invalid'
    );
    expect(route.pathname).toBe(`/projects/${project.id}`);
    expect(route.searchParams.get('schema')).toBe('public');
    expect(route.searchParams.get('table')).toBe('browser_rows');
    expect(JSON.stringify(tables)).not.toContain('9007199254740993');
    expect(
      (
        await call('search_project_mentions', {
          query: "'; drop table browser_rows; --",
        })
      ).items
    ).toEqual([]);
    expect(
      (await project.db.query('select * from public.browser_rows')).rows
    ).toHaveLength(2);
    expect(
      (await call('search_project_mentions', { query: 'x'.repeat(201) })).error
    ).toBeDefined();
  });
  test('mention search preserves project matches when database access is forbidden', async () => {
    const { project, call } = await fixture({ scoped: true, appLink: true });
    harness.mockServer!.use(
      http.post(`${API_URL}/v1/projects/:projectId/database/query`, () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 })
      )
    );
    const result = await call('search_project_mentions', { query: project.id });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].description).toContain(project.id);
  });
  test('query drafts are exposed only by the mounted app, not the server', async () => {
    const { project, call, client } = await fixture({
      scoped: true,
      readOnly: true,
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('open_query');
    expect(names).toContain('open_workspace');
    expect(
      (
        await call('open_query', {
          project_id: project.id,
          title: 'Review',
          sql: 'drop table public.browser_rows;',
        })
      ).error
    ).toBeDefined();
    expect(
      (await project.db.query('select * from public.browser_rows')).rows
    ).toHaveLength(2);
  });
  test('logs use a bounded unified read and never escape a scoped connection', async () => {
    const queryLogs = vi.fn().mockResolvedValue({
      result: [{ timestamp: 1700000000000000, event_message: 'hello' }],
    });
    const platform = createSupabaseApiPlatform({
      accessToken: ACCESS_TOKEN,
      apiUrl: API_URL,
    });
    platform.debugging!.queryLogs = queryLogs;
    const { client } = await setup({
      apps: apps(),
      platform,
      projectId: 'allowed',
    });
    const result = await client.callTool({
      name: 'app_get_logs',
      arguments: { project_id: 'allowed', minutes: 60 },
    });
    expect(result.isError).not.toBe(true);
    expect(queryLogs).toHaveBeenCalledOnce();
    const options = queryLogs.mock.calls[0]![1];
    expect(
      Date.parse(options.iso_timestamp_end) -
        Date.parse(options.iso_timestamp_start)
    ).toBe(3600000);
    expect(options.sql).toContain('LIMIT 100');
    // The surface receives parsed rows and the exact window that was queried.
    expect(result.structuredContent).toEqual({
      rows: [{ timestamp: 1700000000000000, event_message: 'hello' }],
      start: options.iso_timestamp_start,
      end: options.iso_timestamp_end,
    });
    // A query error inside a 200 body is an error, not an empty log list.
    queryLogs.mockResolvedValueOnce({
      result: [],
      error: { message: 'Invalid logs SQL' },
    });
    const failed = await client.callTool({
      name: 'app_get_logs',
      arguments: { project_id: 'allowed', minutes: 60 },
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('Invalid logs SQL');
    expect(queryLogs).toHaveBeenCalledTimes(2);
    queryLogs.mockClear();
    expect(
      (
        await client.callTool({
          name: 'app_get_logs',
          arguments: { project_id: 'other' },
        })
      ).isError
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: 'app_get_logs',
          arguments: { project_id: 'allowed', minutes: 1441 },
        })
      ).isError
    ).toBe(true);
    expect(queryLogs).not.toHaveBeenCalled();
  });
  test('row saves update multiple typed fields atomically and detect any changed field', async () => {
    const { call, target, project } = await fixture();
    const mutation = {
      ...target,
      key: { tenant: 'a', id: '9007199254740993' },
      values: {
        label: "O'Reilly",
        amount: '99999999999999999.12345',
        payload: { nested: [true, null] },
      },
      previous: {
        label: 'First',
        amount: '12345678901234567890.12345',
        payload: { ok: true },
      },
    };
    expect((await call('app_update_row', mutation)).error).toBeUndefined();
    const page = await call('app_read_table', { ...target });
    expect(page.rows[0]).toMatchObject(mutation.values);
    expect(page.rows[1].label).toBe('Second');
    // One mismatched old field rejects the entire update, including other fields.
    expect(
      (
        await call('app_update_row', {
          ...mutation,
          values: { label: 'Must not persist', amount: '7' },
          previous: { label: "O'Reilly", amount: '0' },
        })
      ).error
    ).toBeDefined();
    const after = await project.db.query(
      "select label, amount::text from public.browser_rows where tenant = 'a'"
    );
    expect(after.rows[0]).toEqual({
      label: "O'Reilly",
      amount: '99999999999999999.12345',
    });
  });
  test('row saves reject partial snapshots, empty changes, forbidden fields and ambiguous payloads', async () => {
    const { call, target } = await fixture();
    const mutation = {
      ...target,
      key: { tenant: 'a', id: '9007199254740993' },
      values: { label: 'New' },
      previous: { label: 'First' },
    };
    for (const invalid of [
      { ...mutation, previous: {} },
      { ...mutation, values: {}, previous: {} },
      {
        ...mutation,
        values: { id: '1' },
        previous: { id: '9007199254740993' },
      },
      { ...mutation, values: { missing: 'x' }, previous: { missing: null } },
      { ...mutation, column: 'label', value: 'Ambiguous' },
    ])
      expect((await call('app_update_row', invalid)).error).toBeDefined();
  });
  test('denied account discovery still allows opening an authorized project directly', async () => {
    const { project, call } = await fixture();
    harness.mockServer!.use(
      http.get(
        `${API_URL}/v1/projects`,
        () => new HttpResponse(null, { status: 403 })
      ),
      http.get(
        `${API_URL}/v1/organizations`,
        () => new HttpResponse(null, { status: 403 })
      )
    );
    const initial = await call('open_projects');
    expect(initial.projects).toEqual([]);
    expect(initial.notices).toHaveLength(2);
    expect(initial.capabilities).toMatchObject({
      createProject: false,
      openResource: true,
    });
    const direct = await call('open_projects', { project_ref: project.id });
    expect(direct.projects).toMatchObject([{ id: project.id }]);
    expect(direct.organizations).toEqual([]);
    expect(direct.capabilities.createProject).toBe(false);
    expect(direct.discovery).toEqual({
      projectRef: project.id,
      organizationSlug: null,
    });
  });
  test('denied organization listing does not discard visible projects', async () => {
    const { project, call } = await fixture();
    harness.mockServer!.use(
      http.get(
        `${API_URL}/v1/organizations`,
        () => new HttpResponse(null, { status: 403 })
      )
    );
    const result = await call('open_projects');
    expect(result.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: project.id })])
    );
    expect(result.organizations).toEqual([]);
    expect(result.notices).toHaveLength(1);
  });
  test.each([401, 429, 500])(
    'does not hide HTTP %s as an empty account',
    async (status) => {
      const { call } = await fixture();
      harness.mockServer!.use(
        http.get(
          `${API_URL}/v1/projects`,
          () => new HttpResponse(null, { status })
        )
      );
      expect((await call('open_projects')).error).toBeDefined();
    }
  );
  test('opens database-only project access after a read-only probe, and rejects denied databases', async () => {
    const { project, call } = await fixture();
    harness.mockServer!.use(
      http.get(
        `${API_URL}/v1/projects/:ref`,
        () => new HttpResponse(null, { status: 403 })
      )
    );
    const result = await call('open_projects', { project_ref: project.id });
    expect(result.projects).toEqual([
      {
        id: project.id,
        ref: project.id,
        name: project.id,
        status: 'UNKNOWN',
        region: '',
      },
    ]);
    expect(result.notices).toHaveLength(1);
    harness.mockServer!.use(
      http.post(
        `${API_URL}/v1/projects/:ref/database/query`,
        () => new HttpResponse(null, { status: 403 })
      )
    );
    // No project record is returned unless the authenticated API permits the probe.
    const denied = await call('open_projects', {
      project_ref: project.id,
    });
    expect(denied.error).toBeDefined();
  });
  test('organization discovery paginates without account-wide permissions or org settings', async () => {
    const { call } = await fixture();
    const accountList = vi.fn(() => new HttpResponse(null, { status: 403 }));
    const offsets: number[] = [];
    harness.mockServer!.use(
      http.get(`${API_URL}/v1/projects`, accountList),
      http.get(`${API_URL}/v1/organizations`, accountList),
      http.get(
        `${API_URL}/v1/organizations/scoped-org`,
        () => new HttpResponse(null, { status: 403 })
      ),
      http.get(
        `${API_URL}/v1/organizations/scoped-org/projects`,
        ({ request }) => {
          const offset = Number(
            new URL(request.url).searchParams.get('offset')
          );
          offsets.push(offset);
          return HttpResponse.json({
            projects: [
              {
                ref: `project-${offset}`,
                name: `Project ${offset}`,
                region: 'us-east-1',
                status: 'ACTIVE_HEALTHY',
                inserted_at: '2026-01-01',
                databases: [],
              },
            ],
            pagination: { count: 2, offset, limit: 1 },
          });
        }
      )
    );
    const result = await call('open_projects', {
      organization_slug: 'scoped-org',
    });
    expect(offsets).toEqual([0, 1]);
    expect(accountList).not.toHaveBeenCalled();
    expect(result.projects.map((p: { id: string }) => p.id)).toEqual([
      'project-0',
      'project-1',
    ]);
    expect(result.organizations).toEqual([
      { id: 'scoped-org', name: 'scoped-org', slug: 'scoped-org' },
    ]);
    expect(result.discovery.organizationSlug).toBe('scoped-org');
    expect(accountList).not.toHaveBeenCalled();
  });
  test('explicit discovery cannot escape a configured project scope', async () => {
    const { call } = await fixture({ scoped: true });
    expect(
      (await call('open_projects', { project_ref: 'other' })).error
    ).toBeDefined();
    expect(
      (await call('open_projects', { organization_slug: 'other' })).error
    ).toBeDefined();
  });
  test('entrypoint advertises metadata, accepts empty input, and serves a self-contained resource', async () => {
    const { client, call, project } = await fixture();
    const tools = await client.listTools();
    const entry = tools.tools.find((t) => t.name === 'open_projects');
    expect(entry).toMatchObject({
      title: 'Supabase',
      _meta: {
        'openai/ui': { entrypoints: [{ type: 'global' }] },
        ui: { resourceUri: 'ui://supabase/projects-v1', visibility: ['app'] },
      },
    });
    expect(entry?.icons?.[0]?.src).toContain('data:image/svg+xml,');
    expect(await call('open_projects')).toMatchObject({
      projects: [{ id: project.id }],
      capabilities: { createProject: true, readOnly: false },
    });
    const resource = await client.readResource({
      uri: 'ui://supabase/projects-v1',
    });
    expect(resource.contents[0]).toMatchObject({
      text: expect.stringContaining(surfaceScript('projects')),
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        ui: {
          csp: { connectDomains: [], resourceDomains: [] },
          prefersBorder: false,
        },
      },
    });
  });
  test('bounded reads preserve numeric precision and support literal filtering', async () => {
    const { call, target } = await fixture();
    const result = await call('app_read_table', { ...target, limit: 1 });
    expect(result.rows[0]).toMatchObject({
      id: '9007199254740993',
      amount: '12345678901234567890.12345',
    });
    expect(result.hasMore).toBe(true);
    expect(result.table.primary_keys).toEqual(
      expect.arrayContaining(['tenant', 'id'])
    );
    const filtered = await call('app_read_table', {
      ...target,
      filter: { column: 'label', value: '%' },
    });
    expect(filtered.rows).toEqual([]);
    expect(
      (
        await call('app_read_table', {
          ...target,
          sort: { column: 'label;drop table browser_rows', direction: 'asc' },
        })
      ).error
    ).toBeDefined();
    expect(
      (await call('app_read_table', { ...target, offset: -1 })).error
    ).toBeDefined();
  });
  test('updates only the full primary key, detects stale writes and binds values safely', async () => {
    const { call, target, project } = await fixture();
    const label = "O'Reilly; drop table browser_rows; --";
    const mutation = {
      ...target,
      key: { tenant: 'a', id: '9007199254740993' },
      values: { label },
      previous: { label: 'First' },
    };
    expect((await call('app_update_row', mutation)).error).toBeUndefined();
    expect((await call('app_update_row', mutation)).error).toBeDefined();
    expect(
      (
        await call('app_update_row', {
          ...mutation,
          key: { id: '9007199254740993' },
        })
      ).error
    ).toBeDefined();
    expect(
      (
        await call('app_update_row', {
          ...mutation,
          values: { id: '1' },
          previous: { id: '9007199254740993' },
        })
      ).error
    ).toBeDefined();
    const rows = await project.db.query<{ label: string }>(
      'select label from public.browser_rows order by tenant'
    );
    expect(rows.rows.map((r) => r.label)).toEqual([label, 'Second']);
  });
  test('inserts preserve defaults and support unusual identifiers', async () => {
    const { call, target, project } = await fixture();
    await project.db.exec(
      `create table public."odd'table" (id bigint generated always as identity primary key, "quo'te" text default 'default', "double""quote" text); alter table public."odd'table" enable row level security; create policy browser_read on public."odd'table" for select to supabase_read_only_role using (true);`
    );
    const odd = { ...target, table: "odd'table" };
    expect(
      (
        await call('app_insert_row', {
          ...odd,
          values: { 'double"quote': 'value' },
        })
      ).error
    ).toBeUndefined();
    const result = await call('app_read_table', odd);
    expect(result.rows).toEqual([
      { id: '1', "quo'te": 'default', 'double"quote': 'value' },
    ]);
    expect(
      (await call('app_insert_row', { ...odd, values: { id: '4' } })).error
    ).toBeDefined();
  });
  test('read-only connections reject direct mutations and scoped connections cannot cross projects', async () => {
    const { call, target } = await fixture({ readOnly: true, scoped: true });
    expect((await call('open_projects')).capabilities).toMatchObject({
      createProject: false,
      readOnly: true,
    });
    expect(
      (await call('app_insert_row', { ...target, values: {} })).error
    ).toBeDefined();
    expect(
      (
        await call('app_update_row', {
          ...target,
          key: { tenant: 'a', id: '9007199254740993' },
          values: { label: 'new' },
          previous: { label: 'First' },
        })
      ).error
    ).toBeDefined();
    expect(
      (await call('app_list_schemas', { project_id: 'another-project' })).error
    ).toBeDefined();
    expect(
      (
        await call('app_read_table', {
          ...target,
          project_id: 'another-project',
        })
      ).error
    ).toBeDefined();
  });
  test('managed schemas and missing-primary-key tables cannot be edited', async () => {
    const { call, target, project } = await fixture();
    expect(
      (
        await call('app_insert_row', {
          ...target,
          schema: 'auth',
          values: {},
        })
      ).error
    ).toBeDefined();
    await project.db.exec(
      'create table public.no_key (label text); alter table public.no_key enable row level security;'
    );
    expect(
      (
        await call('app_update_row', {
          ...target,
          table: 'no_key',
          key: {},
          values: { label: 'new' },
          previous: { label: 'old' },
        })
      ).error
    ).toBeDefined();
  });
  test('a new project renders as a card that follows its status through get_project', async () => {
    const { client } = await setup({ apps: apps(), features: ['account'] });
    const listed = (await client.listTools()).tools.find(
      (tool) => tool.name === 'create_project'
    );
    expect(listed?._meta).toMatchObject({
      ui: {
        resourceUri: 'ui://supabase/project-card-v1',
        visibility: ['model', 'app'],
      },
    });

    const org = await createOrganization({
      name: 'Free Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });
    const confirmation = toolPayload(
      await client.callTool({
        name: 'confirm_cost',
        arguments: { type: 'project', recurrence: 'monthly', amount: 0 },
      })
    ) as { confirmation_id: string };
    const created = await client.callTool({
      name: 'create_project',
      arguments: {
        name: 'Card project',
        region: 'us-east-1',
        organization_id: org.id,
        confirm_cost_id: confirmation.confirmation_id,
      },
    });
    // The card reads the same result the model gets, then polls get_project.
    const project = dataOperations.getProject.output.parse(
      toolPayload(created)
    );
    expect(project).toMatchObject({
      name: 'Card project',
      region: 'us-east-1',
    });
    const latest = dataOperations.getProject.output.parse(
      toolPayload(
        await client.callTool({
          name: dataOperations.getProject.tool,
          arguments: dataOperations.getProject.input.parse({ id: project.id }),
        })
      )
    );
    expect(latest).toMatchObject({ id: project.id, name: 'Card project' });
  });
  test('create_project has no view for clients without MCP Apps', async () => {
    const { client } = await harness.setup({
      apps: apps(),
      features: ['account'],
      clientCapabilities: {},
    });
    const listed = (await client.listTools()).tools.find(
      (tool) => tool.name === 'create_project'
    );
    expect(listed).toBeDefined();
    expect(listed?._meta?.ui).toBeUndefined();
  });
  test('default connections do not expose the extension; disabled database features do not gain data tools', async () => {
    const { client } = await setup();
    expect(
      (await client.listTools()).tools.some((t) => t.name === 'open_projects')
    ).toBe(false);
    const other = await setup({ apps: apps(), features: ['account'] });
    const names = (await other.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('open_projects');
    expect(names).not.toContain('app_read_table');
    expect(names).not.toContain('app_insert_row');
  });
  test('data tools are registered from the shared contract and hidden from the model', async () => {
    const { client } = await fixture();
    const tools = (await client.listTools()).tools;
    const appTools = tools.filter((tool) => tool.name.startsWith('app_'));
    expect(appTools.map((tool) => tool.name).sort()).toEqual(
      Object.values(dataOperations)
        .filter((operation) => operation.tool.startsWith('app_'))
        .map((operation) => operation.tool)
        .sort()
    );
    for (const tool of appTools) {
      const operation = Object.values(dataOperations).find(
        (candidate) => candidate.tool === tool.name
      )!;
      expect(tool.description).toBe(operation.description);
      expect(tool._meta).toEqual({ ui: { visibility: ['app'] } });
    }
    // Model-visible SQL tools keep their own approval and read-only policy.
    expect(tools.find((tool) => tool.name === 'execute_sql')?._meta).toBe(
      undefined
    );
  });
  test("views list one schema's tables through list_tables on a scoped connection", async () => {
    const { project, client } = await fixture({ scoped: true });
    await project.db.exec(
      'create schema reporting; create table reporting.daily (id int primary key);'
    );
    // The scoped project is injected, as the MCP Apps data port relies on.
    const list = async (schema: string) =>
      dataOperations.listTables.output.parse(
        toolPayload(
          await client.callTool({
            name: 'list_tables',
            arguments: { schemas: [schema] },
          })
        )
      ).tables;
    expect(await list('public')).toEqual([
      {
        name: 'public.browser_rows',
        rows: expect.any(Number),
        rls_enabled: true,
      },
    ]);
    expect(await list('reporting')).toEqual([
      { name: 'reporting.daily', rows: expect.any(Number), rls_enabled: false },
    ]);
    expect(await list('missing')).toEqual([]);
  });
  test('a local build is inlined and re-read on every read, so rebuilds are served without a restart', async () => {
    const build = await createAppsDir();
    try {
      const { client } = await setup({ apps: { assets: { dir: build.dir } } });
      for (const [revision, uri, surface] of [
        [1, 'ui://supabase/panel-v1', 'panel'],
        [2, 'ui://supabase/panel-v1', 'panel'],
        [2, 'ui://supabase/query-block-v1', 'query-block'],
      ] as const) {
        if (revision === 2) await build.build(2);
        const { contents } = await client.readResource({ uri });
        const text = (contents[0] as { text: string }).text;
        expect(text).toContain(
          `<script type="module">${surfaceScript(surface, revision)}</script>`
        );
        expect(text).toContain(
          `<style>${surfaceStyle(surface, revision)}</style>`
        );
        expect(text).toContain('<div id="root"></div>');
        // Only the inline surface sizes to its content.
        expect(text.includes('data-surface="inline"')).toBe(
          surface === 'query-block'
        );
      }
    } finally {
      await build.cleanup();
    }
  });
  test('inlined assets cannot close their own element early', async () => {
    const build = await createAppsDir();
    try {
      await writeFile(
        join(build.dir, 'projects.js'),
        'const tag = "</script><img src=x>";'
      );
      await writeFile(
        join(build.dir, 'projects.css'),
        'a::after { content: "</style>" }'
      );
      const { client } = await setup({ apps: { assets: { dir: build.dir } } });
      const { contents } = await client.readResource({
        uri: 'ui://supabase/projects-v1',
      });
      const text = (contents[0] as { text: string }).text;
      expect(text).toContain('const tag = "<\\/script><img src=x>";');
      expect(text).toContain('content: "<\\/style>"');
      expect(text.match(/<\/script>/g)).toHaveLength(1);
    } finally {
      await build.cleanup();
    }
  });
  test('an unbuilt or partial apps directory fails reads with the build command', async () => {
    const build = await createAppsDir();
    try {
      await rm(join(build.dir, 'panel.js'));
      const { client } = await setup({ apps: { assets: { dir: build.dir } } });
      // The built surface still loads.
      expect(
        (await client.readResource({ uri: 'ui://supabase/projects-v1' }))
          .contents[0]
      ).toMatchObject({
        text: expect.stringContaining(surfaceScript('projects')),
      });
      await expect(
        client.readResource({ uri: 'ui://supabase/panel-v1' })
      ).rejects.toThrow();
      const panel = getAppResources({ assets: { dir: build.dir } }).find(
        (resource) => resource.uri === 'ui://supabase/panel-v1'
      )!;
      const failure = await panel.read('ui://supabase/panel-v1').then(
        () => '',
        (error: Error) => error.message
      );
      expect(failure).toContain('panel.js');
      expect(failure).toContain(build.dir);
      expect(failure).toContain('pnpm --filter mcp-apps build');
    } finally {
      await build.cleanup();
    }
  });
  test('a published build is linked from its origin, which the resource CSP allows', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { client } = await setup({
      apps: { assets: { url: 'https://cdn.example.com/mcp-apps/v1/' } },
    });
    const { contents } = await client.readResource({
      uri: 'ui://supabase/query-block-v1',
    });
    const text = (contents[0] as { text: string }).text;
    expect(text).toContain(
      '<script type="module" src="https://cdn.example.com/mcp-apps/v1/query-block.js"></script>'
    );
    expect(text).toContain(
      '<link rel="stylesheet" href="https://cdn.example.com/mcp-apps/v1/query-block.css" />'
    );
    expect(contents[0]).toMatchObject({
      _meta: {
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: ['https://cdn.example.com'],
          },
        },
      },
    });
    // Linking never fetches on the server.
    expect(
      fetchSpy.mock.calls.some(([url]) =>
        String(url).includes('cdn.example.com')
      )
    ).toBe(false);
    fetchSpy.mockRestore();
  });
  test('a published build can be fetched and inlined for hosts that block external assets', async () => {
    let served = 0;
    let failing = false;
    harness.mockServer!.use(
      http.get('https://cdn.example.com/mcp-apps/v1/:file', ({ params }) => {
        served++;
        if (failing) return new HttpResponse(null, { status: 503 });
        return HttpResponse.text(`/* ${params.file} */`);
      })
    );
    const { client } = await setup({
      apps: {
        assets: { url: 'https://cdn.example.com/mcp-apps/v1', inline: true },
      },
    });
    const read = () =>
      client.readResource({ uri: 'ui://supabase/projects-v1' }).then(
        (result) => result.contents[0] as { text: string; _meta: unknown },
        (error: Error) => ({ text: error.message, _meta: undefined })
      );
    const first = await read();
    expect(first.text).toContain(
      '<script type="module">/* projects.js */</script>'
    );
    expect(first.text).toContain('<style>/* projects.css */</style>');
    expect(first._meta).toMatchObject({
      ui: { csp: { resourceDomains: [] } },
    });
    // Cached between reads.
    await read();
    expect(served).toBe(2);
    // Failures are reported and not cached.
    failing = true;
    await expect(
      client.readResource({ uri: 'ui://supabase/panel-v1' })
    ).rejects.toThrow();
    const [, panel] = getAppResources({
      assets: { url: 'https://cdn.example.com/mcp-apps/v1', inline: true },
    });
    await expect(panel!.read('ui://supabase/panel-v1')).rejects.toThrow(
      'HTTP 503'
    );
    failing = false;
    expect(
      (await client.readResource({ uri: 'ui://supabase/panel-v1' })).contents[0]
    ).toMatchObject({
      text: expect.stringContaining('/* panel.js */'),
    });
  });
  test('assets must come from HTTPS, or HTTP on this machine', async () => {
    for (const url of [
      'http://cdn.example.com/v1',
      'ftp://cdn.example.com/v1',
      'https://cdn.example.com/v1?token=x',
      'not a url',
    ])
      await expect(setup({ apps: { assets: { url } } })).rejects.toThrow();
    await expect(
      setup({ apps: { assets: { url: 'http://localhost:5175/v1' } } })
    ).resolves.toBeDefined();
  });
  test('app tools are left out for clients known not to render MCP Apps', async () => {
    const appTools = (tools: { name: string }[]) =>
      tools
        .map((tool) => tool.name)
        .filter((name) =>
          [
            'open_projects',
            'open_sql_panel',
            'show_query_block',
            'app_read_table',
          ].includes(name)
        );
    // Advertised support, over a handshake.
    const supported = await setup({ apps: apps() });
    expect(appTools((await supported.client.listTools()).tools)).toEqual([
      'open_projects',
      'open_sql_panel',
      'show_query_block',
      'app_read_table',
    ]);
    // Known capabilities without the extension.
    const unsupported = await harness.setup({
      apps: apps(),
      clientCapabilities: {},
    });
    expect(appTools((await unsupported.client.listTools()).tools)).toEqual([]);
    await expect(
      unsupported.client.callTool({ name: 'open_projects', arguments: {} })
    ).resolves.toMatchObject({ isError: true });
    // A host that lists MIME types without ours.
    const otherMime = await harness.setup({
      apps: apps(),
      clientCapabilities: {
        extensions: {
          'io.modelcontextprotocol/ui': { mimeTypes: ['text/html+skybridge'] },
        },
      } as ClientCapabilities,
    });
    expect(appTools((await otherMime.client.listTools()).tools)).toEqual([]);
    // Embedders can opt every client in.
    const all = await harness.setup({
      apps: { ...apps(), clients: 'all' },
      clientCapabilities: {},
    });
    expect(appTools((await all.client.listTools()).tools)).toHaveLength(4);
  });
  test('2026-era clients advertise MCP Apps support on each request', async () => {
    const modern = await harness.setupModern({
      apps: apps(),
      clientCapabilities: UI_CAPABILITIES,
    });
    expect(
      (await modern.client.listTools()).tools.some(
        (tool) => tool.name === 'show_query_block'
      )
    ).toBe(true);
    const plain = await harness.setupModern({ apps: apps() });
    expect(
      (await plain.client.listTools()).tools.some(
        (tool) => tool.name === 'show_query_block'
      )
    ).toBe(false);
  });
});
