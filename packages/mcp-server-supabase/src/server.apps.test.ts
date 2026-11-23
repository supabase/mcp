import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import {
  isInputRequiredResult,
  type Client,
} from '@modelcontextprotocol/client';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  API_URL,
  createOrganization,
  createProject,
  createProjectFixture,
} from '../test/mocks.js';
import { callModernTool, createServerHarness } from '../test/server-harness.js';
import { DASHBOARD_URL_META_KEY, VIEW_DATA_META_KEY } from './apps/index.js';
import {
  CREATE_BRANCH_UI_URI,
  CREATE_PROJECT_UI_URI,
  getAppResources,
  SHOW_QUERY_UI_URI,
} from './resources/app-resources.js';
import { SHOW_QUERY_ROW_LIMIT } from './tools/database-operation-tools.js';

const harness = createServerHarness();

beforeEach(() => harness.reset());
afterEach(() => harness.close());

const VIEW_URIS = getAppResources().map((view) => view.uri);

const APPS_CLIENT_CAPABILITIES = {
  extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
};

async function linkedViewUris(client: Client) {
  const { tools } = await client.listTools();
  return tools
    .flatMap((tool) => {
      const ui = tool._meta?.ui as { resourceUri?: string } | undefined;
      return ui?.resourceUri ? [ui.resourceUri] : [];
    })
    .sort();
}

async function listedViewUris(client: Client) {
  const { resources } = await client.listResources();
  return resources
    .map((r) => r.uri)
    .filter((uri) => uri.startsWith('ui://'))
    .sort();
}

async function expectViewsUnreadable(client: Client) {
  for (const uri of VIEW_URIS) {
    await expect(client.readResource({ uri }), uri).rejects.toThrow();
  }
}

describe('MCP Apps', () => {
  test('flag off: no MCP Apps anywhere', async () => {
    const { client } = await harness.setupModern({
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
    });

    expect(await linkedViewUris(client)).toEqual([]);
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    expect(client.getServerCapabilities()?.extensions).toBeUndefined();
  });

  test('flag on, client without the extension: no links or views', async () => {
    const { client } = await harness.setupModern({ experimentalApps: true });

    expect(await linkedViewUris(client)).toEqual([]);
    expect(await listedViewUris(client)).toEqual([]);
    await expectViewsUnreadable(client);
    // Capabilities are fixed before any request, so they follow the flag alone.
    expect(client.getServerCapabilities()?.extensions).toEqual({
      [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
    });
  });

  test('flag on, legacy client: no links or views', async () => {
    const { client } = await harness.setup({
      experimentalApps: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
    });

    expect(await linkedViewUris(client)).toEqual([]);
    expect(await listedViewUris(client)).toEqual([]);
    await expectViewsUnreadable(client);
  });

  test('flag on, client with the extension: tools link to listed views', async () => {
    const { client } = await harness.setupModern({
      experimentalApps: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
    });

    const { tools } = await client.listTools();
    const linkOf = (name: string) =>
      (
        tools.find((tool) => tool.name === name)?._meta?.ui as
          | { resourceUri?: string }
          | undefined
      )?.resourceUri;
    expect(linkOf('create_project')).toBe(CREATE_PROJECT_UI_URI);
    expect(linkOf('create_branch')).toBe(CREATE_BRANCH_UI_URI);
    expect(linkOf('show_query')).toBe(SHOW_QUERY_UI_URI);

    expect(await listedViewUris(client)).toEqual([...VIEW_URIS].sort());
    expect(await linkedViewUris(client)).toEqual([...VIEW_URIS].sort());
  });

  test('views set CSP and border metadata in the listing and content', async () => {
    const { client } = await harness.setupModern({
      experimentalApps: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
    });

    const expectedMeta = {
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
        prefersBorder: false,
        permissions: { clipboardWrite: {} },
      },
    };

    const { resources } = await client.listResources();
    for (const uri of VIEW_URIS) {
      const resource = resources.find((r) => r.uri === uri);
      expect(resource?._meta, uri).toEqual(expectedMeta);
      expect(resource?.description, uri).toBeTruthy();

      const { contents } = await client.readResource({ uri });
      expect(contents[0]?._meta, uri).toEqual(expectedMeta);
    }
  });

  test('views are self-contained HTML', async () => {
    const { client } = await harness.setupModern({
      experimentalApps: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
    });

    for (const uri of VIEW_URIS) {
      const { contents } = await client.readResource({ uri });
      const [content] = contents;
      const html = content && 'text' in content ? content.text : '';
      expect(html, uri).toMatch(/^<!doctype html>/i);
      // Built by vite-plugin-singlefile: scripts are inlined, not loaded.
      expect(html, uri).toContain('<script type="module"');
      expect(html, uri).not.toMatch(/<script[^>]*\ssrc=/);
    }
  });

  test('view tool results carry the configured dashboard URL', async () => {
    const { client } = await harness.setupModern({
      experimentalApps: true,
      dashboardUrl: 'https://supabase.green/dashboard/',
      clientCapabilities: {
        ...APPS_CLIENT_CAPABILITIES,
        elicitation: { form: {} },
      },
    });
    const org = await createOrganization({
      name: 'Free Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const result = await callModernTool(client, {
      name: 'create_project',
      arguments: {
        name: 'New Project',
        region: 'us-east-1',
        organization_id: org.id,
      },
    });
    if (isInputRequiredResult(result)) throw new Error('expected a result');

    expect(result._meta?.[DASHBOARD_URL_META_KEY]).toBe(
      'https://supabase.green/dashboard'
    );
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('"name":"New Project"') },
    ]);
  });

  test('a cost form still reaches the client unchanged', async () => {
    const { client } = await harness.setupModern({
      experimentalApps: true,
      clientCapabilities: {
        ...APPS_CLIENT_CAPABILITIES,
        elicitation: { form: {} },
      },
    });
    const org = await createOrganization({
      name: 'Paid Org',
      plan: 'pro',
      allowed_release_channels: ['ga'],
    });
    await createProject({
      name: 'Existing Project',
      region: 'us-east-1',
      organization_id: org.id,
    });

    const result = await callModernTool(client, {
      name: 'create_project',
      arguments: {
        name: 'Paid Project',
        region: 'us-east-1',
        organization_id: org.id,
      },
    });

    expect(isInputRequiredResult(result)).toBe(true);
  });
});

describe('show_query', () => {
  async function setupApps(options: { readOnly?: boolean } = {}) {
    const { client } = await harness.setupModern({
      experimentalApps: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
      ...options,
    });
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });
    const show = async (args: Record<string, unknown>) => {
      const result = await callModernTool(client, {
        name: 'show_query',
        arguments: { project_id: project.id, ...args },
      });
      if (isInputRequiredResult(result)) throw new Error('expected a result');
      return result;
    };
    return { client, project, show };
  }

  const textOf = (result: { content: unknown[] }) =>
    (result.content[0] as { text: string }).text;

  test('is listed only for clients that can render its view', async () => {
    const { client: plain } = await harness.setupModern({
      experimentalApps: true,
    });
    const { tools } = await plain.listTools();
    // execute_sql already gives the model the rows; the view is the point.
    expect(tools.map((tool) => tool.name)).toContain('execute_sql');
    expect(tools.map((tool) => tool.name)).not.toContain('show_query');
  });

  test('sends the rows to the view and only a count to the model', async () => {
    const { show } = await setupApps();

    const result = await show({
      sql: 'select n from generate_series(1, 3) as n order by n',
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      row_count: 3,
      truncated: false,
    });
    expect(result._meta?.[VIEW_DATA_META_KEY]).toEqual({
      rows: [{ n: 1 }, { n: 2 }, { n: 3 }],
      truncated: false,
    });
  });

  test('runs read-only even when the server can write', async () => {
    const { show } = await setupApps();

    const result = await show({
      sql: 'create table notes (id int)',
    });

    // The model can't write through a tool whose results only the user sees.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/read-only|permission denied/i);
  });

  test('sends the view at most the row limit and says so', async () => {
    const { show } = await setupApps();

    const result = await show({
      sql: `select n from generate_series(1, ${SHOW_QUERY_ROW_LIMIT + 5}) as n`,
    });

    expect(JSON.parse(textOf(result))).toEqual({
      row_count: SHOW_QUERY_ROW_LIMIT,
      truncated: true,
    });
    const viewData = result._meta?.[VIEW_DATA_META_KEY] as {
      rows: unknown[];
    };
    expect(viewData.rows).toHaveLength(SHOW_QUERY_ROW_LIMIT);
  });

  test('runs log queries over a resolved window the view can rerun', async () => {
    const { show } = await setupApps();
    let window: Record<string, string | null> = {};
    harness.mockServer!.use(
      http.get(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        ({ request }) => {
          const url = new URL(request.url);
          window = {
            start: url.searchParams.get('iso_timestamp_start'),
            end: url.searchParams.get('iso_timestamp_end'),
          };
          return HttpResponse.json({
            result: [{ timestamp: 1, event_message: 'GET /' }],
          });
        }
      )
    );

    const result = await show({
      source: 'logs',
      sql: "select timestamp, event_message from logs where source = 'edge_logs'",
      iso_timestamp_start: '2026-11-22T10:00:00Z',
      iso_timestamp_end: '2026-11-22T12:00:00Z',
    });

    expect(window).toEqual({
      start: '2026-11-22T10:00:00.000Z',
      end: '2026-11-22T12:00:00.000Z',
    });
    expect(result._meta?.[VIEW_DATA_META_KEY]).toEqual({
      rows: [{ timestamp: 1, event_message: 'GET /' }],
      truncated: false,
      iso_timestamp_start: '2026-11-22T10:00:00.000Z',
      iso_timestamp_end: '2026-11-22T12:00:00.000Z',
    });
  });

  test('turns a logs endpoint error into a tool error', async () => {
    const { show } = await setupApps();
    harness.mockServer!.use(
      http.get(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        () =>
          HttpResponse.json({ result: [], error: { message: 'Syntax error' } })
      )
    );

    const result = await show({ source: 'logs', sql: 'select nope' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Syntax error');
  });
});
