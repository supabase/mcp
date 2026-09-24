import {
  ACCESS_TOKEN,
  API_URL,
  createOrganization,
  createProject,
  createProjectFixture,
  NOTEBOOKS_PAGE_SIZE,
} from '../test/mocks.js';
import { callModernTool, createServerHarness } from '../test/server-harness.js';
import { createSupabaseApiPlatform } from './platform/api-platform.js';
import type { NotebookCell } from './platform/types.js';
import { isInputRequiredResult } from '@modelcontextprotocol/client';
import type {
  CallToolResult,
  ClientCapabilities,
} from '@modelcontextprotocol/client';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = createServerHarness();
const setup = harness.setup;
const setupModern = harness.setupModern;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

const FORM_CAPABLE: ClientCapabilities = { elicitation: { form: {} } };

/** Feature groups that offer `run_notebook` and let it run log cells. */
const RUN_FEATURES = ['notebooks', 'database', 'debugging'];

async function createNotebookFixture(cells: NotebookCell[]) {
  const { project } = await createProjectFixture();
  const notebook = project.createNotebook({
    name: 'Signups',
    content: { schema_version: 1, cells },
  });
  return { project, notebook };
}

function runArgs(
  project: { id: string },
  notebook: { id: string; attributes: { updated_at: string } }
) {
  return {
    project_id: project.id,
    notebook_id: notebook.id,
    expected_updated_at: notebook.attributes.updated_at,
  };
}

/** Extracts the per-cell results from the untrusted data boundary. */
function parseCellResults(cells: string) {
  const match = cells.match(
    /<untrusted-data-[\w-]+>\n([\s\S]*?)\n<\/untrusted-data-/
  );
  if (!match) {
    throw new Error('expected an untrusted data boundary');
  }
  return JSON.parse(match[1]!);
}

function parseToolResult(result: CallToolResult) {
  const [content] = result.content;
  if (content?.type !== 'text') {
    throw new Error('expected text content');
  }
  return JSON.parse(content.text);
}

describe('tools', () => {
  test('list notebooks', async () => {
    const { callTool } = await setup({ features: ['notebooks'] });

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

    project.createNotebook({ name: 'Notebook 1', favorite: true });
    project.createNotebook({
      name: 'Notebook 2',
      description: 'Second notebook',
    });

    const result = await callTool({
      name: 'list_notebooks',
      arguments: {
        project_id: project.id,
      },
    });

    expect(Array.isArray(result.notebooks)).toBe(true);
    expect(result.notebooks.length).toBe(2);
    expect(result.notebooks[0]).toEqual(
      expect.objectContaining({
        name: 'Notebook 1',
        description: null,
        favorite: true,
        inserted_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
    expect(result.notebooks[1]).toEqual(
      expect.objectContaining({
        name: 'Notebook 2',
        description: 'Second notebook',
        favorite: false,
      })
    );
    // list_notebooks omits cell content
    expect(result.notebooks[0].content).toBeUndefined();
  });

  test('list notebooks follows pagination across multiple pages', async () => {
    const { callTool } = await setup({ features: ['notebooks'] });

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

    // One more notebook than fits in two pages, so the mock's page size
    // forces the client to follow `links.next` at least twice.
    const notebookCount = NOTEBOOKS_PAGE_SIZE * 2 + 1;
    const names = Array.from(
      { length: notebookCount },
      (_, i) => `Notebook ${i + 1}`
    );
    for (const name of names) {
      project.createNotebook({ name });
    }

    const result = await callTool({
      name: 'list_notebooks',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result.notebooks.length).toBe(notebookCount);
    expect(result.notebooks.map((notebook: any) => notebook.name)).toEqual(
      names
    );
  });

  test('get notebook', async () => {
    const { callTool } = await setup({ features: ['notebooks'] });

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

    const notebook = project.createNotebook({
      name: 'Notebook 1',
      content: {
        schema_version: 1,
        cells: [{ id: 'cell-1', type: 'markdown', text: 'Hello world' }],
      },
    });

    const result = await callTool({
      name: 'get_notebook',
      arguments: {
        project_id: project.id,
        notebook_id: notebook.id,
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: notebook.id,
        name: 'Notebook 1',
        content: {
          schema_version: 1,
          cells: expect.any(String),
        },
      })
    );
    expect(result.content.cells).toContain('untrusted user data');
    expect(result.content.cells).toMatch(
      /<untrusted-data-\w{8}-\w{4}-\w{4}-\w{4}-\w{12}>/
    );
    expect(result.content.cells).toContain(
      JSON.stringify([{ id: 'cell-1', type: 'markdown', text: 'Hello world' }])
    );
  });

  test('get notebook that does not exist throws an error', async () => {
    const { callTool } = await setup({ features: ['notebooks'] });

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

    const result = callTool({
      name: 'get_notebook',
      arguments: {
        project_id: project.id,
        notebook_id: 'does-not-exist',
      },
    });

    await expect(result).rejects.toThrow('Notebook not found');
  });
});

describe('run_notebook', () => {
  test('runs query cells in notebook order and skips markdown', async () => {
    const { callTool } = await setup({ features: RUN_FEATURES });
    harness.mockServer?.use(
      http.get(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        () =>
          HttpResponse.json({
            result: [{ event_message: 'Auth error' }],
            error: null,
          })
      )
    );
    const { project, notebook } = await createNotebookFixture([
      { id: 'intro', type: 'markdown', text: 'Signup metrics' },
      {
        id: 'one',
        type: 'database',
        title: 'One',
        sql: 'select 1 as one',
        row_limit: 100,
      },
      {
        id: 'series',
        type: 'database',
        sql: 'select * from generate_series(1, 5) as n',
        row_limit: 2,
      },
      {
        id: 'errors',
        type: 'log',
        title: 'Auth errors',
        sql: "select * from logs where source = 'auth_logs'",
        time_range: { type: 'relative', unit: 'hour', amount: 1 },
      },
    ]);

    const result = await callTool({
      name: 'run_notebook',
      arguments: runArgs(project, notebook),
    });

    expect(result).toEqual({
      id: notebook.id,
      name: 'Signups',
      updated_at: notebook.attributes.updated_at,
      cells: expect.stringContaining('untrusted user data'),
    });
    expect(parseCellResults(result.cells)).toEqual([
      {
        cell_id: 'one',
        title: 'One',
        type: 'database',
        status: 'success',
        rows: [{ one: 1 }],
      },
      {
        cell_id: 'series',
        type: 'database',
        status: 'success',
        rows: [{ n: 1 }, { n: 2 }],
      },
      {
        cell_id: 'errors',
        title: 'Auth errors',
        type: 'log',
        status: 'success',
        rows: [{ event_message: 'Auth error' }],
      },
    ]);
  });

  test('a failing cell does not stop later cells', async () => {
    const { callTool } = await setup({ features: RUN_FEATURES });
    const { project, notebook } = await createNotebookFixture([
      { id: 'bad', type: 'database', sql: 'invalid sql', row_limit: 100 },
      { id: 'good', type: 'database', sql: 'select 2 as two', row_limit: 100 },
    ]);

    const result = await callTool({
      name: 'run_notebook',
      arguments: runArgs(project, notebook),
    });

    expect(parseCellResults(result.cells)).toEqual([
      {
        cell_id: 'bad',
        type: 'database',
        status: 'error',
        error: expect.stringContaining('syntax error at or near "invalid"'),
      },
      {
        cell_id: 'good',
        type: 'database',
        status: 'success',
        rows: [{ two: 2 }],
      },
    ]);
  });

  test('rejects a run when the notebook changed since expected_updated_at', async () => {
    const { callTool } = await setup({ features: RUN_FEATURES });
    const { project, notebook } = await createNotebookFixture([
      { id: 'one', type: 'database', sql: 'select 1', row_limit: 100 },
    ]);

    const result = callTool({
      name: 'run_notebook',
      arguments: {
        ...runArgs(project, notebook),
        expected_updated_at: '2020-01-01T00:00:00.000Z',
      },
    });

    await expect(result).rejects.toThrow(
      'Call get_notebook again and retry run_notebook'
    );
  });

  test('runs valid SQL with existing row limits unchanged', async () => {
    const { callTool } = await setup({ features: RUN_FEATURES });
    const queries = [
      'select 1 as n limit 1 /* existing limit */',
      'select 1 as n fetch next 1 rows only',
      'select 1 as n limit all',
    ];
    const { project, notebook } = await createNotebookFixture(
      queries.map((sql, index) => ({
        id: String(index),
        type: 'database',
        sql,
        row_limit: 100,
      }))
    );

    const result = await callTool({
      name: 'run_notebook',
      arguments: runArgs(project, notebook),
    });

    expect(parseCellResults(result.cells)).toEqual(
      queries.map((_, index) => ({
        cell_id: String(index),
        type: 'database',
        status: 'success',
        rows: [{ n: 1 }],
      }))
    );
  });

  test('returns log errors for notebook repair and continues', async () => {
    const error = 'Unknown identifier missing_column';
    const { callTool } = await setup({ features: RUN_FEATURES });
    harness.mockServer?.use(
      http.get(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        ({ request }) =>
          HttpResponse.json(
            new URL(request.url).searchParams
              .get('sql')
              ?.includes('missing_column')
              ? { result: [], error }
              : { result: [{ event_message: 'Recovered' }], error: null }
          )
      )
    );
    const { project, notebook } = await createNotebookFixture([
      {
        id: 'logs',
        type: 'log',
        title: 'Log events',
        sql: 'select missing_column from logs',
        time_range: { type: 'relative', unit: 'hour', amount: 1 },
      },
      { id: 'db', type: 'database', sql: 'select 1 as n', row_limit: 100 },
    ]);

    const result = await callTool({
      name: 'run_notebook',
      arguments: runArgs(project, notebook),
    });
    expect(parseCellResults(result.cells)).toEqual([
      {
        cell_id: 'logs',
        title: 'Log events',
        type: 'log',
        status: 'error',
        error,
      },
      {
        cell_id: 'db',
        type: 'database',
        status: 'success',
        rows: [{ n: 1 }],
      },
    ]);

    // Simulate correcting the reported cell and validating the new notebook.
    notebook.content.cells = notebook.content.cells.map((cell) =>
      cell.type === 'log'
        ? { ...cell, sql: 'select event_message from logs' }
        : cell
    );
    notebook.attributes.updated_at = new Date(
      Date.parse(notebook.attributes.updated_at) + 1000
    ).toISOString();
    const corrected = await callTool({
      name: 'run_notebook',
      arguments: runArgs(project, notebook),
    });
    expect(parseCellResults(corrected.cells)).toEqual([
      {
        cell_id: 'logs',
        title: 'Log events',
        type: 'log',
        status: 'success',
        rows: [{ event_message: 'Recovered' }],
      },
      {
        cell_id: 'db',
        type: 'database',
        status: 'success',
        rows: [{ n: 1 }],
      },
    ]);
  });

  test('only runs database cells that target the primary database', async () => {
    const { client, platform } = await setupModern({
      features: RUN_FEATURES,
      clientCapabilities: FORM_CAPABLE,
    });
    const executeSql = vi.spyOn(platform.database!, 'executeSql');
    const { project } = await createProjectFixture();
    const notebook = project.createNotebook({
      name: 'Replicas',
      content: {
        schema_version: 1,
        cells: [
          {
            id: 'primary',
            type: 'database',
            sql: 'select 1 as one',
            row_limit: 100,
            database_identifier: project.id,
          },
          {
            id: 'replica',
            type: 'database',
            sql: 'drop table films',
            row_limit: 100,
            database_identifier: `${project.id}-rr-us-east-1`,
          },
        ],
      },
    });

    const result = await callModernTool(client, {
      name: 'run_notebook',
      arguments: runArgs(project, notebook),
    });

    expect(isInputRequiredResult(result)).toBe(false);
    expect(executeSql).toHaveBeenCalledOnce();
    expect(
      parseCellResults(parseToolResult(result as CallToolResult).cells)
    ).toEqual([
      expect.objectContaining({ cell_id: 'primary', status: 'success' }),
      expect.objectContaining({
        cell_id: 'replica',
        status: 'error',
        error: expect.stringContaining('read replica'),
      }),
    ]);
  });

  test('log cells query the cell time range', async () => {
    const platform = createSupabaseApiPlatform({
      accessToken: ACCESS_TOKEN,
      apiUrl: API_URL,
    });
    const queryLogs = vi.spyOn(platform.debugging!, 'queryLogs');
    const { callTool } = await setup({ platform, features: RUN_FEATURES });
    const sql = "select * from logs where source = 'edge_logs'";
    const { project, notebook } = await createNotebookFixture([
      {
        id: 'edge',
        type: 'log',
        sql,
        time_range: {
          type: 'absolute',
          start: '2026-09-01T00:00:00.000Z',
          end: '2026-09-01T06:00:00.000Z',
        },
      },
    ]);

    await callTool({
      name: 'run_notebook',
      arguments: runArgs(project, notebook),
    });

    expect(queryLogs).toHaveBeenCalledWith(project.id, {
      sql,
      iso_timestamp_start: '2026-09-01T00:00:00.000Z',
      iso_timestamp_end: '2026-09-01T06:00:00.000Z',
    });
  });

  test.each([
    ['a relative range', { type: 'relative', unit: 'day', amount: 7 }],
    [
      'an absolute range',
      {
        type: 'absolute',
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-09-03T00:00:00.000Z',
      },
    ],
  ] as const)(
    'log cells with %s over 24 hours fail without querying',
    async (_, time_range) => {
      const platform = createSupabaseApiPlatform({
        accessToken: ACCESS_TOKEN,
        apiUrl: API_URL,
      });
      const queryLogs = vi.spyOn(platform.debugging!, 'queryLogs');
      const { callTool } = await setup({ platform, features: RUN_FEATURES });
      const { project, notebook } = await createNotebookFixture([
        { id: 'week', type: 'log', sql: 'select * from logs', time_range },
      ]);

      const result = await callTool({
        name: 'run_notebook',
        arguments: runArgs(project, notebook),
      });

      expect(parseCellResults(result.cells)).toEqual([
        {
          cell_id: 'week',
          type: 'log',
          status: 'error',
          error: 'The log window can be at most 24 hours.',
        },
      ]);
      expect(queryLogs).not.toHaveBeenCalled();
    }
  );

  test.each([
    ['the debugging feature is disabled', ['notebooks', 'database'], false],
    ['the platform cannot query logs', RUN_FEATURES, true],
  ])('log cells fail when %s', async (_, features, withoutQueryLogs) => {
    const platform = createSupabaseApiPlatform({
      accessToken: ACCESS_TOKEN,
      apiUrl: API_URL,
    });
    const { callTool } = await setup({
      platform: withoutQueryLogs
        ? {
            ...platform,
            debugging: { ...platform.debugging!, queryLogs: undefined },
          }
        : platform,
      features,
    });
    const { project, notebook } = await createNotebookFixture([
      {
        id: 'errors',
        type: 'log',
        sql: 'select * from logs',
        time_range: { type: 'relative', unit: 'hour', amount: 1 },
      },
      { id: 'one', type: 'database', sql: 'select 1 as one', row_limit: 100 },
    ]);

    const result = await callTool({
      name: 'run_notebook',
      arguments: runArgs(project, notebook),
    });

    expect(parseCellResults(result.cells)).toEqual([
      {
        cell_id: 'errors',
        type: 'log',
        status: 'error',
        error:
          'Log queries are not available on this server, so log cells cannot be run.',
      },
      expect.objectContaining({ cell_id: 'one', status: 'success' }),
    ]);
  });

  test('database cells fail when the database feature is disabled', async () => {
    const { callTool } = await setup({ features: ['notebooks', 'debugging'] });
    harness.mockServer?.use(
      http.get(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        () =>
          HttpResponse.json({
            result: [{ event_message: 'Auth error' }],
            error: null,
          })
      )
    );
    const { project, notebook } = await createNotebookFixture([
      { id: 'one', type: 'database', sql: 'select 1 as one', row_limit: 100 },
      {
        id: 'errors',
        type: 'log',
        sql: "select * from logs where source = 'auth_logs'",
        time_range: { type: 'relative', unit: 'hour', amount: 1 },
      },
    ]);

    const result = await callTool({
      name: 'run_notebook',
      arguments: runArgs(project, notebook),
    });

    expect(parseCellResults(result.cells)).toEqual([
      {
        cell_id: 'one',
        type: 'database',
        status: 'error',
        error:
          'Database queries are not available on this server, so database cells cannot be run.',
      },
      {
        cell_id: 'errors',
        type: 'log',
        status: 'success',
        rows: [{ event_message: 'Auth error' }],
      },
    ]);
  });

  test('read-only mode runs database cells read-only', async () => {
    const { callTool, client } = await setup({
      features: RUN_FEATURES,
      readOnly: true,
    });
    const { project, notebook } = await createNotebookFixture([
      {
        id: 'write',
        type: 'database',
        sql: 'create table films (id int)',
        row_limit: 100,
      },
    ]);

    const { tools } = await client.listTools();
    const runNotebook = tools.find((tool) => tool.name === 'run_notebook');
    expect(runNotebook?.annotations?.readOnlyHint).toBe(true);

    const result = await callTool({
      name: 'run_notebook',
      arguments: runArgs(project, notebook),
    });

    expect(parseCellResults(result.cells)).toEqual([
      expect.objectContaining({
        cell_id: 'write',
        status: 'error',
        error: expect.stringContaining('permission denied'),
      }),
    ]);
  });

  describe('confirmation via elicitation', () => {
    test.each([{}, FORM_CAPABLE, { elicitation: { url: {} } }])(
      'non-destructive database and log cells run without elicitation (%j)',
      async (clientCapabilities) => {
        const { client, platform } = await setupModern({
          features: RUN_FEATURES,
          clientCapabilities,
        });
        const executeSql = vi.spyOn(platform.database!, 'executeSql');
        const queryLogs = vi.spyOn(platform.debugging!, 'queryLogs');
        harness.mockServer!.use(
          http.get(
            `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
            () => HttpResponse.json({ result: [{ count: 1 }], error: null })
          )
        );
        const { project, notebook } = await createNotebookFixture([
          {
            id: 'one',
            type: 'database',
            sql: 'select 1 as one',
            row_limit: 100,
          },
          {
            id: 'logs',
            type: 'log',
            sql: 'select count(*) from logs',
            time_range: { type: 'relative', unit: 'hour', amount: 1 },
          },
        ]);
        const result = await callModernTool(client, {
          name: 'run_notebook',
          arguments: runArgs(project, notebook),
        });
        expect(isInputRequiredResult(result)).toBe(false);
        expect(executeSql).toHaveBeenCalledOnce();
        expect(queryLogs).toHaveBeenCalledOnce();
        expect(
          parseCellResults(parseToolResult(result as CallToolResult).cells)
        ).toEqual([
          expect.objectContaining({
            cell_id: 'one',
            status: 'success',
            rows: [{ one: 1 }],
          }),
          expect.objectContaining({
            cell_id: 'logs',
            status: 'success',
            rows: [{ count: 1 }],
          }),
        ]);
      }
    );

    test.each([{}, { elicitation: { url: {} } }])(
      'destructive SQL without form support blocks the entire run (%j)',
      async (clientCapabilities) => {
        const { client, platform } = await setupModern({
          features: RUN_FEATURES,
          clientCapabilities,
        });
        const executeSql = vi.spyOn(platform.database!, 'executeSql');
        const queryLogs = vi.spyOn(platform.debugging!, 'queryLogs');
        const { project, notebook } = await createNotebookFixture([
          { id: 'one', type: 'database', sql: 'select 1', row_limit: 100 },
          {
            id: 'logs',
            type: 'log',
            sql: 'select * from logs',
            time_range: { type: 'relative', unit: 'hour', amount: 1 },
          },
          {
            id: 'cleanup',
            type: 'database',
            sql: 'delete from films',
            row_limit: 100,
          },
        ]);
        const result = await callModernTool(client, {
          name: 'run_notebook',
          arguments: runArgs(project, notebook),
        });
        expect(result).toMatchObject({ isError: true });
        expect(JSON.stringify(result)).toContain(
          'does not support form elicitation'
        );
        expect(executeSql).not.toHaveBeenCalled();
        expect(queryLogs).not.toHaveBeenCalled();
      }
    );

    test.each([{}, FORM_CAPABLE])(
      'disabled database cells cannot execute or trigger confirmation (%j)',
      async (clientCapabilities) => {
        const { client, platform } = await setupModern({
          features: ['notebooks', 'debugging'],
          clientCapabilities,
        });
        const executeSql = vi.spyOn(platform.database!, 'executeSql');
        const queryLogs = vi.spyOn(platform.debugging!, 'queryLogs');
        harness.mockServer!.use(
          http.get(
            `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
            () => HttpResponse.json({ result: [], error: null })
          )
        );
        const { project, notebook } = await createNotebookFixture([
          {
            id: 'cleanup',
            type: 'database',
            sql: 'drop table films',
            row_limit: 100,
          },
          {
            id: 'logs',
            type: 'log',
            sql: 'select * from logs',
            time_range: { type: 'relative', unit: 'hour', amount: 1 },
          },
        ]);
        const result = await callModernTool(client, {
          name: 'run_notebook',
          arguments: runArgs(project, notebook),
        });
        expect(isInputRequiredResult(result)).toBe(false);
        expect(
          parseCellResults(parseToolResult(result as CallToolResult).cells)
        ).toEqual([
          expect.objectContaining({
            cell_id: 'cleanup',
            status: 'error',
            error: expect.stringContaining(
              'Database queries are not available'
            ),
          }),
          expect.objectContaining({ cell_id: 'logs', status: 'success' }),
        ]);
        expect(executeSql).not.toHaveBeenCalled();
        expect(queryLogs).toHaveBeenCalledOnce();
      }
    );

    test.each([{}, FORM_CAPABLE])(
      'explicitly disabling confirmation allows destructive runs (%j)',
      async (clientCapabilities) => {
        const { client, platform } = await setupModern({
          features: RUN_FEATURES,
          clientCapabilities,
          elicitation: {
            requestState: { key: 'a'.repeat(32), principal: 'test-user' },
            confirmation: { enabledTools: ['execute_sql'] },
          },
        });
        const executeSql = vi.spyOn(platform.database!, 'executeSql');
        const { project, notebook } = await createNotebookFixture([
          {
            id: 'cleanup',
            type: 'database',
            sql: 'delete from films where false',
            row_limit: 100,
          },
        ]);
        await project.db.exec('create table films (id int)');
        const result = await callModernTool(client, {
          name: 'run_notebook',
          arguments: runArgs(project, notebook),
        });
        expect(isInputRequiredResult(result)).toBe(false);
        expect(executeSql).toHaveBeenCalledOnce();
        expect(result).not.toHaveProperty('isError', true);
      }
    );

    test.each(['decline', 'cancel'] as const)(
      'honors %s even after destructive SQL becomes non-destructive',
      async (action) => {
        const { client, platform } = await setupModern({
          features: RUN_FEATURES,
          clientCapabilities: FORM_CAPABLE,
        });
        const executeSql = vi.spyOn(platform.database!, 'executeSql');
        const { project, notebook } = await createNotebookFixture([
          {
            id: 'cleanup',
            type: 'database',
            sql: 'delete from films',
            row_limit: 100,
          },
        ]);
        const first = await callModernTool(client, {
          name: 'run_notebook',
          arguments: runArgs(project, notebook),
        });
        if (!isInputRequiredResult(first))
          throw new Error('expected confirmation');
        notebook.content.cells = [
          { id: 'one', type: 'database', sql: 'select 1', row_limit: 100 },
        ];
        const result = await callModernTool(client, {
          name: 'run_notebook',
          arguments: runArgs(project, notebook),
          requestState: first.requestState,
          inputResponses: { confirm_run: { action } },
        });
        expect(result).toMatchObject({
          structuredContent: {
            status: action === 'decline' ? 'declined' : 'cancelled',
          },
        });
        expect(executeSql).not.toHaveBeenCalled();
      }
    );

    test('form-capable client: confirmation links to the notebook instead of listing SQL', async () => {
      const { client } = await setupModern({
        features: RUN_FEATURES,
        clientCapabilities: FORM_CAPABLE,
      });
      const { project, notebook } = await createNotebookFixture([
        { id: 'intro', type: 'markdown', text: 'Signup metrics' },
        {
          id: 'signups',
          type: 'database',
          title: 'Daily signups',
          sql: 'delete from auth.users where false',
          row_limit: 100,
        },
        {
          id: 'errors',
          type: 'log',
          sql: "select * from logs where source = 'auth_logs'",
          time_range: { type: 'relative', unit: 'hour', amount: 6 },
        },
      ]);

      const first = await callModernTool(client, {
        name: 'run_notebook',
        arguments: runArgs(project, notebook),
      });

      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }
      expect(first.inputRequests?.confirm_run).toMatchObject({
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: [
            'Run notebook? Query cells: 2.',
            'Potentially destructive queries: 1. These may modify or delete data.',
            `Review notebook: https://supabase.com/dashboard/project/${project.id}/explorer/notebook/${notebook.id}`,
          ].join('\n'),
        },
      });
    });

    test('form-capable client: checks the full SQL while keeping confirmation short', async () => {
      const { client } = await setupModern({
        features: RUN_FEATURES,
        clientCapabilities: FORM_CAPABLE,
      });
      // A destructive statement after a long query must still require confirmation.
      const longQuery = `select ${'1'.repeat(2000)}`;
      const { project, notebook } = await createNotebookFixture([
        {
          id: 'padded',
          type: 'database',
          sql: `${longQuery}; drop table films`,
          row_limit: 100,
        },
        {
          id: 'count',
          type: 'database',
          title: 'Count',
          sql: 'select count(*) from films',
          row_limit: 100,
        },
        {
          id: 'cleanup',
          type: 'database',
          title: 'Cleanup',
          sql: 'delete from films',
          row_limit: 100,
        },
      ]);

      const first = await callModernTool(client, {
        name: 'run_notebook',
        arguments: runArgs(project, notebook),
      });

      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }
      expect(first.inputRequests?.confirm_run).toMatchObject({
        params: {
          message: [
            'Run notebook? Query cells: 3.',
            'Potentially destructive queries: 2. These may modify or delete data.',
            `Review notebook: https://supabase.com/dashboard/project/${project.id}/explorer/notebook/${notebook.id}`,
          ].join('\n'),
        },
      });
    });

    test.each([false, true])(
      'read-only runs do not elicit even for destructive SQL (form support: %s)',
      async (formCapable) => {
        const { client, platform } = await setupModern({
          features: RUN_FEATURES,
          clientCapabilities: formCapable ? FORM_CAPABLE : {},
          readOnly: true,
        });
        const executeSql = vi.spyOn(platform.database!, 'executeSql');
        const { project, notebook } = await createNotebookFixture([
          {
            id: 'cleanup',
            type: 'database',
            sql: 'delete from films',
            row_limit: 100,
          },
        ]);
        await project.db.exec('create table films (id int)');
        const result = await callModernTool(client, {
          name: 'run_notebook',
          arguments: runArgs(project, notebook),
        });
        expect(isInputRequiredResult(result)).toBe(false);
        expect(executeSql).toHaveBeenCalledWith(project.id, {
          query: 'delete from films',
          read_only: true,
        });
        expect(
          parseCellResults(parseToolResult(result as CallToolResult).cells)
        ).toEqual([
          expect.objectContaining({
            status: 'error',
            error: expect.stringContaining('permission denied'),
          }),
        ]);
      }
    );

    test('asks again when the execution mode changes to read-only', async () => {
      // The HTTP entry shares a signing key/principal across read_only options.
      const original = await setupModern({
        features: RUN_FEATURES,
        clientCapabilities: FORM_CAPABLE,
        readOnly: false,
      });
      const current = await setupModern({
        features: RUN_FEATURES,
        clientCapabilities: FORM_CAPABLE,
        readOnly: true,
      });
      const originalExecuteSql = vi.spyOn(
        original.platform.database!,
        'executeSql'
      );
      const executeSql = vi.spyOn(current.platform.database!, 'executeSql');
      const { project, notebook } = await createNotebookFixture([
        {
          id: 'write',
          type: 'database',
          sql: 'delete from films where false',
          row_limit: 100,
        },
      ]);
      const args = runArgs(project, notebook);
      await project.db.exec('create table films (id int)');
      const first = await callModernTool(original.client, {
        name: 'run_notebook',
        arguments: args,
      });
      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }

      const second = await callModernTool(current.client, {
        name: 'run_notebook',
        arguments: args,
        requestState: first.requestState,
        inputResponses: { confirm_run: { action: 'accept', content: {} } },
      });
      if (!isInputRequiredResult(second)) {
        throw new Error('expected confirmation for the changed execution mode');
      }
      expect(second.inputRequests?.confirm_run).toMatchObject({
        params: {
          message: expect.stringContaining('Database queries run read-only.'),
        },
      });
      expect(originalExecuteSql).not.toHaveBeenCalled();
      expect(executeSql).not.toHaveBeenCalled();

      const result = await callModernTool(current.client, {
        name: 'run_notebook',
        arguments: args,
        requestState: second.requestState,
        inputResponses: { confirm_run: { action: 'accept', content: {} } },
      });
      if (isInputRequiredResult(result)) {
        throw new Error('expected a CallToolResult after fresh approval');
      }
      expect(executeSql).toHaveBeenCalledOnce();
      expect(parseCellResults(parseToolResult(result).cells)).toEqual([
        expect.objectContaining({
          cell_id: 'write',
          status: 'error',
          error: expect.stringContaining('permission denied'),
        }),
      ]);
    });

    test('form-capable client: accept runs every query cell once', async () => {
      const { client, platform } = await setupModern({
        features: RUN_FEATURES,
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'accept',
      });
      const executeSql = vi.spyOn(platform.database!, 'executeSql');
      const { project, notebook } = await createNotebookFixture([
        { id: 'one', type: 'database', sql: 'select 1 as one', row_limit: 100 },
        {
          id: 'two',
          type: 'database',
          sql: 'delete from films where false',
          row_limit: 100,
        },
      ]);

      await project.db.exec('create table films (id int)');
      const result = (await client.callTool({
        name: 'run_notebook',
        arguments: runArgs(project, notebook),
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(executeSql).toHaveBeenCalledTimes(2);
      expect(parseCellResults(parseToolResult(result).cells)).toEqual([
        expect.objectContaining({ cell_id: 'one', rows: [{ one: 1 }] }),
        expect.objectContaining({ cell_id: 'two', rows: [] }),
      ]);
    });

    test.each([
      ['decline', 'declined'],
      ['cancel', 'cancelled'],
    ] as const)(
      'form-capable client: %s does not run any cell',
      async (elicitationAction, status) => {
        const { client, platform } = await setupModern({
          features: RUN_FEATURES,
          clientCapabilities: FORM_CAPABLE,
          elicitationAction,
        });
        const executeSql = vi.spyOn(platform.database!, 'executeSql');
        const { project, notebook } = await createNotebookFixture([
          {
            id: 'one',
            type: 'database',
            sql: 'delete from films where false',
            row_limit: 100,
          },
        ]);

        const result = await client.callTool({
          name: 'run_notebook',
          arguments: runArgs(project, notebook),
        });

        expect(result.structuredContent).toEqual({ status });
        expect(executeSql).not.toHaveBeenCalled();
      }
    );

    test('form-capable client: a notebook without query cells runs without elicitation', async () => {
      const { client } = await setupModern({
        features: RUN_FEATURES,
        clientCapabilities: FORM_CAPABLE,
      });
      const { project, notebook } = await createNotebookFixture([
        { id: 'intro', type: 'markdown', text: 'Nothing to run' },
      ]);

      const result = await callModernTool(client, {
        name: 'run_notebook',
        arguments: runArgs(project, notebook),
      });

      expect(isInputRequiredResult(result)).toBe(false);
      expect(
        parseCellResults(parseToolResult(result as CallToolResult).cells)
      ).toEqual([]);
    });

    test('asks again when the cells changed after confirmation was requested', async () => {
      const { client, platform } = await setupModern({
        features: RUN_FEATURES,
        clientCapabilities: FORM_CAPABLE,
      });
      const executeSql = vi.spyOn(platform.database!, 'executeSql');
      const cell: NotebookCell = {
        id: 'one',
        type: 'database',
        sql: 'delete from films where false',
        row_limit: 100,
      };
      const { project, notebook } = await createNotebookFixture([cell]);
      const args = runArgs(project, notebook);

      const first = await callModernTool(client, {
        name: 'run_notebook',
        arguments: args,
      });
      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }

      // Change the SQL without bumping updated_at, so only the signed cell
      // hash can tell that the user approved different SQL.
      notebook.content.cells = [{ ...cell, sql: 'drop table films' }];

      const second = await callModernTool(client, {
        name: 'run_notebook',
        arguments: args,
        requestState: first.requestState,
        inputResponses: {
          confirm_run: { action: 'accept', content: {} },
        },
      });

      if (!isInputRequiredResult(second)) {
        throw new Error('expected a fresh input_required result');
      }
      expect(second.inputRequests?.confirm_run).toMatchObject({
        params: {
          message: expect.stringContaining(`/explorer/notebook/${notebook.id}`),
        },
      });
      expect(executeSql).not.toHaveBeenCalled();
    });

    test('rejects a retry for a different notebook than the state was minted for', async () => {
      const { client, platform } = await setupModern({
        features: RUN_FEATURES,
        clientCapabilities: FORM_CAPABLE,
      });
      const executeSql = vi.spyOn(platform.database!, 'executeSql');
      const cells: NotebookCell[] = [
        {
          id: 'one',
          type: 'database',
          sql: 'delete from films where false',
          row_limit: 100,
        },
      ];
      const { project, notebook } = await createNotebookFixture(cells);
      const other = project.createNotebook({
        name: 'Other',
        content: { schema_version: 1, cells },
      });

      const first = await callModernTool(client, {
        name: 'run_notebook',
        arguments: runArgs(project, notebook),
      });
      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }

      const second = await callModernTool(client, {
        name: 'run_notebook',
        arguments: runArgs(project, other),
        requestState: first.requestState,
        inputResponses: {
          confirm_run: { action: 'accept', content: {} },
        },
      });

      if (isInputRequiredResult(second)) {
        throw new Error('expected a CallToolResult');
      }
      expect(second.content).toContainEqual({
        type: 'text',
        text: 'Request state arguments do not match the current arguments.',
      });
      expect(second.isError).toBe(true);
      expect(executeSql).not.toHaveBeenCalled();
    });

    test('rejects a requestState minted by execute_sql', async () => {
      const { client, platform } = await setupModern({
        features: RUN_FEATURES,
        clientCapabilities: FORM_CAPABLE,
      });
      const executeSql = vi.spyOn(platform.database!, 'executeSql');
      const { project, notebook } = await createNotebookFixture([
        {
          id: 'one',
          type: 'database',
          sql: 'delete from films where false',
          row_limit: 100,
        },
      ]);

      const sqlFirst = await callModernTool(client, {
        name: 'execute_sql',
        arguments: { project_id: project.id, query: 'drop table films' },
      });
      if (!isInputRequiredResult(sqlFirst)) {
        throw new Error('expected an input_required result from execute_sql');
      }

      const result = await callModernTool(client, {
        name: 'run_notebook',
        arguments: runArgs(project, notebook),
        requestState: sqlFirst.requestState,
        inputResponses: {
          confirm_run: { action: 'accept', content: {} },
        },
      });

      if (isInputRequiredResult(result)) {
        throw new Error('expected a CallToolResult');
      }
      expect(result.content).toContainEqual({
        type: 'text',
        text: 'Request state was not issued for run_notebook.',
      });
      expect(result.isError).toBe(true);
      expect(executeSql).not.toHaveBeenCalled();
    });

    test('capability-free client runs without elicitation when confirmation is configured', async () => {
      const platform = createSupabaseApiPlatform({
        accessToken: ACCESS_TOKEN,
        apiUrl: API_URL,
      });
      const executeSql = vi.spyOn(platform.database!, 'executeSql');
      const { callTool } = await setup({
        platform,
        features: RUN_FEATURES,
        elicitation: {
          requestState: { key: 'a'.repeat(32), principal: 'test-user' },
          confirmation: { enabledTools: ['run_notebook'] },
        },
      });
      const { project, notebook } = await createNotebookFixture([
        { id: 'one', type: 'database', sql: 'select 1', row_limit: 100 },
      ]);

      await callTool({
        name: 'run_notebook',
        arguments: runArgs(project, notebook),
      });

      expect(executeSql).toHaveBeenCalledOnce();
    });
  });
});

describe('create_notebook', () => {
  const content = {
    cells: [
      { type: 'markdown', text: '# Weekly review' },
      {
        type: 'database',
        sql: 'select 1 as total',
        row_limit: 25,
        title: 'Total',
        view: 'chart',
        chart: {
          type: 'bar',
          x_column: 'day',
          y_series: [{ column: 'total' }],
          scale: 'linear',
          cumulative: false,
          show_labels: true,
        },
      },
      {
        type: 'log',
        sql: "select timestamp, event_message from logs where source = 'auth_logs'",
        time_range: { type: 'relative', unit: 'day', amount: 7 },
      },
    ],
  };
  const proposal = {
    name: 'Weekly review',
    description: 'Saved investigation',
    content,
  };

  test('creates through the v2 API, assigns ids, and round-trips all cells without executing SQL', async () => {
    const platform = createSupabaseApiPlatform({
      accessToken: ACCESS_TOKEN,
      apiUrl: API_URL,
    });
    const executeSql = vi.spyOn(platform.database!, 'executeSql');
    const queryLogs = vi.spyOn(platform.debugging!, 'queryLogs');
    const { callTool } = await setup({ platform, features: ['notebooks'] });
    const { project } = await createProjectFixture();
    let sentBody: unknown;
    harness.mockServer!.use(
      http.post(
        `${API_URL}/v2/projects/:ref/notebooks`,
        async ({ request }) => {
          sentBody = await request.clone().json();
          // Fall through to the shared API mock, which persists the notebook.
        }
      )
    );

    const created = await callTool({
      name: 'create_notebook',
      arguments: { project_id: project.id, ...proposal },
    });
    expect(sentBody).toEqual({
      data: { type: 'notebook', attributes: proposal },
    });
    expect(created).toEqual({
      id: expect.any(String),
      name: proposal.name,
      updated_at: expect.any(String),
    });
    const listed = await callTool({
      name: 'list_notebooks',
      arguments: { project_id: project.id },
    });
    expect(listed.notebooks).toContainEqual(expect.objectContaining(created));
    const fetched = await callTool({
      name: 'get_notebook',
      arguments: { project_id: project.id, notebook_id: created.id },
    });
    expect(fetched.description).toBe(proposal.description);
    expect(fetched.content.schema_version).toBe(1);
    const cells = parseCellResults(fetched.content.cells);
    expect(cells).toEqual(
      content.cells.map((cell) => ({ ...cell, id: expect.any(String) }))
    );
    expect(new Set(cells.map((cell: { id: string }) => cell.id)).size).toBe(3);
    expect(executeSql).not.toHaveBeenCalled();
    expect(queryLogs).not.toHaveBeenCalled();
  });

  test('project-scoped creation uses the configured project and can be run separately', async () => {
    const { project } = await createProjectFixture();
    const { project: other } = await createProjectFixture();
    const { callTool, client } = await setup({
      projectId: project.id,
      features: RUN_FEATURES,
    });
    const { tools } = await client.listTools();
    const tool = tools.find((tool) => tool.name === 'create_notebook');
    expect(tool?.inputSchema.properties).not.toHaveProperty('project_id');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    await expect(
      callTool({
        name: 'create_notebook',
        arguments: { project_id: other.id, ...proposal },
      })
    ).rejects.toThrow('project_id');
    const created = await callTool({
      name: 'create_notebook',
      arguments: {
        name: 'One',
        content: {
          cells: [{ type: 'database', sql: 'select 1 as one', row_limit: 100 }],
        },
      },
    });
    expect(project.notebooks.has(created.id)).toBe(true);
    expect(other.notebooks.size).toBe(0);
    const fetched = await callTool({
      name: 'get_notebook',
      arguments: { notebook_id: created.id },
    });
    const run = await callTool({
      name: 'run_notebook',
      arguments: {
        notebook_id: created.id,
        expected_updated_at: fetched.updated_at,
      },
    });
    expect(parseCellResults(run.cells)).toEqual([
      expect.objectContaining({ status: 'success', rows: [{ one: 1 }] }),
    ]);
  });

  test('read-only mode hides creation and rejects direct calls', async () => {
    const { client, callTool } = await setup({
      features: ['notebooks'],
      readOnly: true,
    });
    const { project } = await createProjectFixture();
    expect(
      (await client.listTools()).tools.map((tool) => tool.name)
    ).not.toContain('create_notebook');
    await expect(
      callTool({
        name: 'create_notebook',
        arguments: { project_id: project.id, ...proposal },
      })
    ).rejects.toThrow('Cannot create notebook in read-only mode.');
    expect(project.notebooks.size).toBe(0);
  });

  test.each([
    { type: 'markdown', id: 'invented', text: 'hello' },
    { type: 'database', sql: 'select 1', row_limit: 100, id: 'invented' },
    { type: 'database', sql: 'select 1' },
    {
      type: 'database',
      sql: 'select 1',
      row_limit: 100,
      database_identifier: '',
    },
    { type: 'unknown', text: 'hello' },
    {
      type: 'log',
      sql: 'select 1',
      time_range: { type: 'relative', unit: 'day', amount: 0 },
    },
    {
      type: 'log',
      sql: 'select 1',
      time_range: { type: 'relative', unit: 'day', amount: 1.5 },
    },
    {
      type: 'log',
      sql: 'select 1',
      time_range: {
        type: 'absolute',
        start: 'invalid',
        end: '2026-09-24T00:00:00Z',
      },
    },
    {
      type: 'log',
      sql: 'select 1',
      time_range: {
        type: 'absolute',
        start: '2026-09-24T00:00:00Z',
        end: '2026-09-23T00:00:00Z',
      },
    },
  ])('rejects invalid cell input before saving: %j', async (cell) => {
    const { client } = await setup({ features: ['notebooks'] });
    const { project } = await createProjectFixture();
    const result = await client.callTool({
      name: 'create_notebook',
      arguments: {
        project_id: project.id,
        name: 'Invalid',
        content: { cells: [cell] },
      },
    });
    expect(result.isError).toBe(true);
    expect(project.notebooks.size).toBe(0);
  });

  test('preserves absolute log windows and explicit database targets', async () => {
    const { callTool } = await setup({ features: ['notebooks'] });
    const { project } = await createProjectFixture();
    const cells = [
      {
        type: 'database',
        database_identifier: project.id,
        sql: 'select 1',
        row_limit: 100,
      },
      {
        type: 'log',
        sql: 'select timestamp from logs',
        time_range: {
          type: 'absolute',
          start: '2026-09-23T00:00:00+10:00',
          end: '2026-09-24T00:00:00+10:00',
        },
      },
    ];
    const created = await callTool({
      name: 'create_notebook',
      arguments: {
        project_id: project.id,
        name: 'Explicit sources',
        content: { cells },
      },
    });
    expect(project.notebooks.get(created.id)?.content.cells).toEqual(
      cells.map((cell) => ({ ...cell, id: expect.any(String) }))
    );
  });

  test.each([
    [
      401,
      { message: 'Unauthorized' },
      'Unauthorized. Please provide a valid access token',
    ],
    [
      403,
      {
        error: {
          code: 'forbidden',
          message: 'Insufficient notebook permissions',
        },
      },
      'Insufficient notebook permissions',
    ],
    [500, {}, 'Failed to create notebook'],
  ])('surfaces API errors (%s)', async (status, body, message) => {
    const { callTool } = await setup({ features: ['notebooks'] });
    harness.mockServer!.use(
      http.post(`${API_URL}/v2/projects/:ref/notebooks`, () =>
        HttpResponse.json(body, { status })
      )
    );
    await expect(
      callTool({
        name: 'create_notebook',
        arguments: { project_id: 'test-project', ...proposal },
      })
    ).rejects.toThrow(message);
  });

  describe('confirmation via elicitation', () => {
    test('creation rejects approval issued for running a notebook', async () => {
      const { client } = await setupModern({
        features: RUN_FEATURES,
        clientCapabilities: FORM_CAPABLE,
      });
      const { project, notebook } = await createNotebookFixture([
        { id: 'one', type: 'database', sql: 'select 1', row_limit: 100 },
      ]);
      const first = await callModernTool(client, {
        name: 'run_notebook',
        arguments: runArgs(project, notebook),
      });
      if (!isInputRequiredResult(first))
        throw new Error('expected input_required');
      const result = await callModernTool(client, {
        name: 'create_notebook',
        arguments: {
          project_id: project.id,
          name: 'New notebook',
          content: { cells: [] },
        },
        requestState: first.requestState,
        inputResponses: { confirm_create: { action: 'accept', content: {} } },
      });
      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Request state was not issued for create_notebook.',
          },
        ],
      });
      expect(project.notebooks.size).toBe(1);
    });

    test('shows all proposed content before saving, including markdown-only notebooks', async () => {
      const { client } = await setupModern({
        features: ['notebooks'],
        clientCapabilities: FORM_CAPABLE,
      });
      const { project } = await createProjectFixture();
      const args = {
        project_id: project.id,
        name: 'Notes',
        content: { cells: [content.cells[0]] },
      };
      const first = await callModernTool(client, {
        name: 'create_notebook',
        arguments: args,
      });
      if (!isInputRequiredResult(first))
        throw new Error('expected input_required');
      expect(first.inputRequests?.confirm_create).toMatchObject({
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: expect.stringContaining('# Weekly review'),
        },
      });
      expect(project.notebooks.size).toBe(0);
      const result = await callModernTool(client, {
        name: 'create_notebook',
        arguments: args,
        requestState: first.requestState,
        inputResponses: { confirm_create: { action: 'accept', content: {} } },
      });
      if (isInputRequiredResult(result))
        throw new Error('expected created notebook');
      expect(result.isError).not.toBe(true);
      expect(project.notebooks.size).toBe(1);
    });

    test.each(['accept', 'decline', 'cancel'] as const)(
      '%s saves only with approval',
      async (elicitationAction) => {
        const { client, platform } = await setupModern({
          features: ['notebooks'],
          clientCapabilities: FORM_CAPABLE,
          elicitationAction,
        });
        const executeSql = vi.spyOn(platform.database!, 'executeSql');
        const { project } = await createProjectFixture();
        const result = await client.callTool({
          name: 'create_notebook',
          arguments: { project_id: project.id, ...proposal },
        });
        expect(project.notebooks.size).toBe(
          elicitationAction === 'accept' ? 1 : 0
        );
        if (elicitationAction !== 'accept')
          expect(result.structuredContent).toEqual({
            status: elicitationAction === 'decline' ? 'declined' : 'cancelled',
          });
        expect(executeSql).not.toHaveBeenCalled();
      }
    );

    test.each([
      { name: 'Changed title' },
      { description: 'Changed description' },
      { content: { cells: [{ type: 'markdown', text: 'Changed content' }] } },
    ])('asks again when the approved proposal changes: %j', async (changes) => {
      const { client } = await setupModern({
        features: ['notebooks'],
        clientCapabilities: FORM_CAPABLE,
      });
      const { project } = await createProjectFixture();
      const args = { project_id: project.id, ...proposal };
      const first = await callModernTool(client, {
        name: 'create_notebook',
        arguments: args,
      });
      if (!isInputRequiredResult(first))
        throw new Error('expected input_required');
      const changed = { ...args, ...changes };
      const second = await callModernTool(client, {
        name: 'create_notebook',
        arguments: changed,
        requestState: first.requestState,
        inputResponses: { confirm_create: { action: 'accept', content: {} } },
      });
      expect(isInputRequiredResult(second)).toBe(true);
      expect(project.notebooks.size).toBe(0);
      if (!isInputRequiredResult(second))
        throw new Error('expected fresh approval');
      const result = await callModernTool(client, {
        name: 'create_notebook',
        arguments: changed,
        requestState: second.requestState,
        inputResponses: { confirm_create: { action: 'accept', content: {} } },
      });
      expect(isInputRequiredResult(result)).toBe(false);
      expect(project.notebooks.size).toBe(1);
    });

    test('rejects approval for a different project', async () => {
      const { client } = await setupModern({
        features: ['notebooks'],
        clientCapabilities: FORM_CAPABLE,
      });
      const { project } = await createProjectFixture();
      const { project: other } = await createProjectFixture();
      const first = await callModernTool(client, {
        name: 'create_notebook',
        arguments: { project_id: project.id, ...proposal },
      });
      if (!isInputRequiredResult(first))
        throw new Error('expected input_required');
      const result = await callModernTool(client, {
        name: 'create_notebook',
        arguments: { project_id: other.id, ...proposal },
        requestState: first.requestState,
        inputResponses: { confirm_create: { action: 'accept', content: {} } },
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { status: 'error' },
      });
      expect(project.notebooks.size + other.notebooks.size).toBe(0);
    });

    test.each([false, true])(
      'preserves execution without an active form gate (form support: %s)',
      async (formCapable) => {
        const { client } = await setupModern({
          features: ['notebooks'],
          clientCapabilities: formCapable ? FORM_CAPABLE : {},
          elicitation: {
            requestState: { key: 'a'.repeat(32), principal: 'test-user' },
            confirmation: {
              enabledTools: formCapable
                ? ['run_notebook']
                : ['create_notebook'],
            },
          },
        });
        const { project } = await createProjectFixture();
        const result = await callModernTool(client, {
          name: 'create_notebook',
          arguments: {
            project_id: project.id,
            name: 'Empty',
            content: { cells: [] },
          },
        });
        expect(isInputRequiredResult(result)).toBe(false);
        expect(project.notebooks.size).toBe(1);
      }
    );
  });
});
