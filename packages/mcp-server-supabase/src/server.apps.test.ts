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
  SHOW_ISSUES_UI_URI,
} from './resources/app-resources.js';
import { SHOW_ISSUES_TYPE_LIMIT } from './tools/debugging-tools.js';

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
    expect(linkOf('show_issues')).toBe(SHOW_ISSUES_UI_URI);

    expect(await listedViewUris(client)).toEqual([...VIEW_URIS].sort());
    expect(await linkedViewUris(client)).toEqual([...VIEW_URIS].sort());
  });

  test('views set CSP and border metadata in the listing and content', async () => {
    const { client } = await harness.setupModern({
      experimentalApps: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
    });

    const baseUi = {
      csp: { connectDomains: [], resourceDomains: [] },
      prefersBorder: false,
      permissions: { clipboardWrite: {} },
    };
    // Panels (issues) open beside the conversation; the cards stay inline.
    const panels = [SHOW_ISSUES_UI_URI];
    const expectedMeta = (uri: string) => {
      const mode = panels.includes(uri) ? 'fullscreen' : 'inline';
      return {
        ui: { ...baseUi, preferredDisplayMode: mode },
        'openai/ui': {
          preferredDisplayMode: mode,
          availableDisplayModes: [mode],
        },
      };
    };

    const { resources } = await client.listResources();
    for (const uri of VIEW_URIS) {
      const resource = resources.find((r) => r.uri === uri);
      expect(resource?._meta, uri).toEqual(expectedMeta(uri));
      expect(resource?.description, uri).toBeTruthy();

      const { contents } = await client.readResource({ uri });
      expect(contents[0]?._meta, uri).toEqual(expectedMeta(uri));
    }
  });

  test('tools that open a panel ask ChatGPT to open it fullscreen', async () => {
    const { client } = await harness.setupModern({
      experimentalApps: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
    });

    const { tools } = await client.listTools();
    const openaiUi = (name: string) =>
      tools.find((tool) => tool.name === name)?._meta?.['openai/ui'];
    expect(openaiUi('show_issues')).toEqual({
      preferredModelDisplayMode: 'fullscreen',
    });
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

describe('show_issues', () => {
  const lint = (name: string, level: string, object: string) => ({
    name,
    title: name.replaceAll('_', ' '),
    level,
    facing: 'EXTERNAL',
    categories: ['SECURITY'],
    description: name,
    detail: object,
    remediation: 'https://supabase.com/docs/guides/database/database-linter',
    metadata: { schema: 'public', name: object, type: 'table' },
    cache_key: `${name}_${object}`,
  });

  async function setupApps(advisors: {
    security?: () => Response;
    performance?: () => Response;
  }) {
    const { client } = await harness.setupModern({
      experimentalApps: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
    });
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });
    for (const type of ['security', 'performance'] as const) {
      const respond = advisors[type];
      if (respond)
        harness.mockServer!.use(
          http.get(
            `${API_URL}/v1/projects/:projectId/advisors/${type}`,
            respond
          )
        );
    }
    const show = async () => {
      const result = await callModernTool(client, {
        name: 'show_issues',
        arguments: { project_id: project.id },
      });
      if (isInputRequiredResult(result)) throw new Error('expected a result');
      return result;
    };
    return { show };
  }

  const textOf = (result: { content: unknown[] }) =>
    (result.content[0] as { text: string }).text;

  test('is listed only for clients that can render its view', async () => {
    const { client: plain } = await harness.setupModern({
      experimentalApps: true,
    });
    const { tools } = await plain.listTools();
    // get_advisors already gives the model the issues; the view is the point.
    expect(tools.map((tool) => tool.name)).toContain('get_advisors');
    expect(tools.map((tool) => tool.name)).not.toContain('show_issues');
  });

  test('sends one row per warning or error to the view, errors first, and only counts to the model', async () => {
    const { show } = await setupApps({
      security: () =>
        HttpResponse.json({
          lints: [
            lint('function_search_path_mutable', 'WARN', 'a'),
            lint('rls_disabled_in_public', 'ERROR', 'orders'),
            lint('rls_disabled_in_public', 'ERROR', 'notes'),
            lint('function_search_path_mutable', 'WARN', 'b'),
            lint('function_search_path_mutable', 'WARN', 'c'),
            // Info lints are suggestions, not issues.
            lint('unused_index', 'INFO', 'orders'),
          ],
        }),
    });

    const result = await show();

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      security: 2,
      performance: 0,
      health: 1,
    });
    expect(result._meta?.[VIEW_DATA_META_KEY]).toEqual({
      security: {
        status: 'ready',
        data: {
          total: 2,
          truncated: false,
          issues: [
            {
              name: 'rls_disabled_in_public',
              title: 'rls disabled in public',
              level: 'ERROR',
              count: 2,
            },
            {
              name: 'function_search_path_mutable',
              title: 'function search path mutable',
              level: 'WARN',
              count: 3,
            },
          ],
        },
      },
      performance: {
        status: 'ready',
        data: { total: 0, truncated: false, issues: [] },
      },
      // The health advisor's own check results (project inactive, check
      // unavailable) are left out, as get_advisors leaves them out.
      health: {
        status: 'ready',
        data: {
          total: 1,
          truncated: false,
          issues: [
            {
              name: 'log_data_api_error_rate_high',
              title: 'Data API error rate is high',
              level: 'ERROR',
              count: 1,
            },
          ],
        },
      },
    });
  });

  test('shows an advisor that fails as unavailable, never as no issues', async () => {
    const { show } = await setupApps({
      performance: () =>
        HttpResponse.json({ message: 'Upgrade required' }, { status: 403 }),
    });

    const result = await show();

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      security: 0,
      performance: null,
      health: 1,
    });
    const viewData = result._meta?.[VIEW_DATA_META_KEY] as {
      performance: { status: string; message: string };
    };
    expect(viewData.performance.status).toBe('unavailable');
    expect(viewData.performance.message).toBeTruthy();
  });

  test('sends the view at most the issue type limit and says so', async () => {
    const lints = Array.from({ length: SHOW_ISSUES_TYPE_LIMIT + 3 }, (_, i) =>
      lint(`lint_${i}`, 'WARN', 'orders')
    );
    const { show } = await setupApps({
      security: () => HttpResponse.json({ lints }),
    });

    const result = await show();

    expect(JSON.parse(textOf(result)).security).toBe(
      SHOW_ISSUES_TYPE_LIMIT + 3
    );
    const viewData = result._meta?.[VIEW_DATA_META_KEY] as {
      security: { data: { issues: unknown[]; truncated: boolean } };
    };
    expect(viewData.security.data.issues).toHaveLength(SHOW_ISSUES_TYPE_LIMIT);
    expect(viewData.security.data.truncated).toBe(true);
  });
});
