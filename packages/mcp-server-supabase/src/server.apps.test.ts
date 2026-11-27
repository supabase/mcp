import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import {
  type CallToolResult,
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
import type { IssuesPage, ShowIssuesViewData } from './apps/show-issues.js';
import type { SupabasePlatform } from './platform/types.js';
import {
  CREATE_BRANCH_UI_URI,
  CREATE_PROJECT_UI_URI,
  getAppResources,
  SHOW_ISSUES_UI_URI,
} from './resources/app-resources.js';
import { viewOnlyToolSet } from './tools/tool-schemas.js';

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

  test('views set CSP, border and display mode metadata in the listing and content', async () => {
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
      'openai/ui': {
        availableDisplayModes: ['inline'],
        preferredDisplayMode: 'inline',
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

describe('OpenAI plugin extensions', () => {
  test('stays off when experimentalApps is false', async () => {
    const { client } = await harness.setupModern({
      experimentalApps: false,
      openaiPluginExtensions: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
    });

    expect(await linkedViewUris(client)).toEqual([]);
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    expect(client.getServerCapabilities()?.extensions).toBeUndefined();
  });

  test('flag on leaves base views unchanged for capable clients', async () => {
    const { client } = await harness.setupModern({
      experimentalApps: true,
      openaiPluginExtensions: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
    });

    expect(await listedViewUris(client)).toEqual([...VIEW_URIS].sort());
    expect(await linkedViewUris(client)).toEqual([...VIEW_URIS].sort());
  });

  test('flag on grants nothing without the MCP Apps capability', async () => {
    const incapable = await harness.setupModern({
      experimentalApps: true,
      openaiPluginExtensions: true,
    });
    expect(await linkedViewUris(incapable.client)).toEqual([]);
    expect(await listedViewUris(incapable.client)).toEqual([]);
    await expectViewsUnreadable(incapable.client);

    const legacy = await harness.setup({
      experimentalApps: true,
      openaiPluginExtensions: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
    });
    expect(await linkedViewUris(legacy.client)).toEqual([]);
    expect(await listedViewUris(legacy.client)).toEqual([]);
    await expectViewsUnreadable(legacy.client);
  });
});

describe('issues view tools', () => {
  async function setupApps(
    options: Parameters<typeof harness.setupModern>[0] = {}
  ) {
    return harness.setupModern({
      experimentalApps: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
      ...options,
    });
  }

  /** Serves `lints` for one category and none for the others. */
  function mockLints(
    category: 'security' | 'performance',
    lints: { name: string; level: 'INFO' | 'WARN' | 'ERROR' }[]
  ) {
    harness.mockServer?.use(
      http.get(`${API_URL}/v1/projects/:projectId/advisors/${category}`, () =>
        HttpResponse.json({
          lints: lints.map((lint) => ({
            ...lint,
            title: `Title ${lint.name}`,
            description: 'Description',
            detail: 'Detail',
          })),
        })
      ),
      http.post(`${API_URL}/v2/projects/:projectId/advisors/run`, () =>
        HttpResponse.json({
          data: { type: 'project_advisors', attributes: { lints: [] } },
        })
      )
    );
  }

  async function callView(
    client: Client,
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const result = await callModernTool(client, { name, arguments: args });
    if (isInputRequiredResult(result)) throw new Error('expected a result');
    return result;
  }

  function textOf(result: CallToolResult) {
    const [content] = result.content;
    if (content?.type !== 'text') throw new Error('expected text content');
    return content.text;
  }

  function viewDataOf(result: CallToolResult) {
    return result._meta?.[VIEW_DATA_META_KEY] as ShowIssuesViewData;
  }

  test.each([
    ['flag off', { experimentalApps: false }],
    ['client without the extension', { clientCapabilities: {} }],
  ])('%s: view-only tools are not listed or callable', async (_, options) => {
    const { project } = await createProjectFixture();
    const { client } = await setupApps(options);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('get_issues');
    expect([...viewOnlyToolSet].sort()).toEqual([
      'app_paginate_issues',
      'show_issues',
    ]);
    for (const name of viewOnlyToolSet) {
      expect(names).not.toContain(name);
      const result = await callView(client, name, { project_id: project.id });
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toContain('tool not found');
    }
  });

  test('legacy client: view-only tools are not listed', async () => {
    const { client } = await harness.setup({
      experimentalApps: true,
      clientCapabilities: APPS_CLIENT_CAPABILITIES,
    });

    const { tools } = await client.listTools();
    for (const name of viewOnlyToolSet) {
      expect(tools.map((tool) => tool.name)).not.toContain(name);
    }
  });

  test('app_paginate_issues is listed for the view only', async () => {
    const { client } = await setupApps();

    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === 'app_paginate_issues');
    expect(tool?._meta).toEqual({ ui: { visibility: ['app'] } });
    const annotationsOf = (name: string) =>
      tools.find((tool) => tool.name === name)?.annotations;
    const { title: _, ...readOnly } = annotationsOf('get_issues') ?? {};
    expect(readOnly).toMatchObject({ readOnlyHint: true });
    expect(annotationsOf('show_issues')).toEqual({
      ...readOnly,
      title: 'Show project issues',
    });
    expect(annotationsOf('app_paginate_issues')).toEqual({
      ...readOnly,
      title: 'Page project issues',
    });
  });

  test('show_issues tells the model one sentence and gives the view its data', async () => {
    mockLints('security', [
      { name: 'warning_check', level: 'WARN' },
      { name: 'critical_check', level: 'ERROR' },
      { name: 'critical_check', level: 'ERROR' },
      { name: 'info_check', level: 'INFO' },
    ]);
    const { project } = await createProjectFixture();
    const { client } = await setupApps();

    const before = Date.now();
    const result = await callView(client, 'show_issues', {
      project_id: project.id,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Opened the issues view for the user. It lists 2 issues. To read the issues yourself, use get_issues.',
      },
    ]);
    expect(result.structuredContent).toBeUndefined();
    expect(result._meta?.[DASHBOARD_URL_META_KEY]).toBeDefined();

    const data = viewDataOf(result);
    expect(data.page).toEqual({
      issues: [
        {
          id: 'critical_check',
          category: 'security',
          title: 'Title critical_check',
          severity: 'critical',
          affected_count: 2,
        },
        {
          id: 'warning_check',
          category: 'security',
          title: 'Title warning_check',
          severity: 'warning',
          affected_count: 1,
        },
      ],
      total: 2,
      counts: { all: 2, security: 2, performance: 0, health: 0 },
      checks: [
        { type: 'security', status: 'complete' },
        { type: 'performance', status: 'complete' },
        { type: 'health', status: 'complete' },
      ],
      next_cursor: null,
      read_at: expect.any(String),
    });
    expect(data.opened.project).toBe(project.id);
    expect(data.opened.at).toBeGreaterThanOrEqual(before);
    expect(data.context).toEqual({
      project: {
        id: project.id,
        ref: project.ref,
        name: project.name,
      },
      connection: { readOnly: false, scopedProjectId: null },
    });
  });

  test('show_issues counts the requested type and reports the connection scope', async () => {
    mockLints('performance', [{ name: 'slow', level: 'WARN' }]);
    const { project } = await createProjectFixture();
    const { client } = await setupApps({
      projectId: project.id,
      readOnly: true,
    });

    const result = await callView(client, 'show_issues', { type: 'security' });

    expect(textOf(result)).toBe(
      'Opened the issues view for the user. It lists 0 issues. To read the issues yourself, use get_issues.'
    );
    const data = viewDataOf(result);
    expect(data.page.total).toBe(0);
    expect(data.page.counts).toEqual({
      all: 1,
      security: 0,
      performance: 1,
      health: 0,
    });
    expect(data.context.connection).toEqual({
      readOnly: true,
      scopedProjectId: project.id,
    });
  });

  test('show_issues reports one unavailable category and keeps the others', async () => {
    mockLints('security', [{ name: 'only_check', level: 'WARN' }]);
    harness.mockServer?.use(
      http.post(`${API_URL}/v2/projects/:projectId/advisors/run`, () =>
        HttpResponse.json({ message: 'Health is down' }, { status: 500 })
      )
    );
    const { project } = await createProjectFixture();
    const { client } = await setupApps();

    const result = await callView(client, 'show_issues', {
      project_id: project.id,
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('It lists 1 issue.');
    const { page } = viewDataOf(result);
    expect(page.issues.map(({ id }) => id)).toEqual(['only_check']);
    expect(page.checks).toEqual([
      { type: 'security', status: 'complete' },
      { type: 'performance', status: 'complete' },
      { type: 'health', status: 'unavailable', reason: expect.any(String) },
    ]);
  });

  test('show_issues still opens when the project cannot be read', async () => {
    mockLints('security', []);
    const { project } = await createProjectFixture();
    harness.mockServer?.use(
      http.get(`${API_URL}/v1/projects/:projectId`, () =>
        HttpResponse.json({ message: 'Unavailable' }, { status: 500 })
      )
    );
    const { client } = await setupApps();

    const result = await callView(client, 'show_issues', {
      project_id: project.id,
    });

    expect(result.isError).toBeFalsy();
    expect(viewDataOf(result).context.project).toEqual({ id: project.id });
  });

  test('pages from show_issues to the end with app_paginate_issues', async () => {
    const names = Array.from(
      { length: 45 },
      (_, i) => `check_${String(i).padStart(2, '0')}`
    );
    mockLints(
      'security',
      names.map((name, i) => ({ name, level: i % 3 ? 'WARN' : 'ERROR' }))
    );
    const { project } = await createProjectFixture();
    const { client } = await setupApps();

    const first = viewDataOf(
      await callView(client, 'show_issues', { project_id: project.id })
    ).page;
    const pages: IssuesPage[] = [first];
    let cursor = first.next_cursor;
    while (cursor) {
      const result = await callView(client, 'app_paginate_issues', {
        project_id: project.id,
        cursor,
      });
      expect(result.isError).toBeFalsy();
      const page = JSON.parse(textOf(result)) as IssuesPage;
      pages.push(page);
      cursor = page.next_cursor;
    }

    expect(pages.map((page) => page.issues.length)).toEqual([20, 20, 5]);
    const seen = pages.flatMap((page) => page.issues.map(({ id }) => id));
    expect(new Set(seen).size).toBe(45);
    expect(pages.every((page) => page.total === 45)).toBe(true);

    // No cursor reads the first page again, which is how the view refreshes.
    const refreshed = await callView(client, 'app_paginate_issues', {
      project_id: project.id,
      limit: 50,
    });
    expect(
      JSON.parse(textOf(refreshed)).issues.map(({ id }: { id: string }) => id)
    ).toEqual(seen);
  });

  test.each([
    ['garbage', 'not-a-cursor'],
    [
      'made for another type',
      Buffer.from(
        JSON.stringify({
          v: 1,
          type: 'health',
          after: ['warning', 'health', 'x'],
        })
      ).toString('base64url'),
    ],
  ])('app_paginate_issues rejects a cursor that is %s', async (_, cursor) => {
    const { project } = await createProjectFixture();
    const { client } = await setupApps();

    const result = await callView(client, 'app_paginate_issues', {
      project_id: project.id,
      cursor,
    });

    expect(result.isError).toBe(true);
    // The view starts over on the code; the message is for the model.
    expect(JSON.parse(textOf(result))).toEqual({
      error: {
        name: 'ToolCallerError',
        message: expect.stringContaining('cursor is invalid'),
        code: 'invalid_cursor',
      },
    });
  });

  test('app_paginate_issues takes every type on a platform without health advisors', async () => {
    const platform: SupabasePlatform = {
      debugging: {
        async getLogs() {
          return [];
        },
        async getSecurityAdvisors() {
          return {
            lints: [
              {
                name: 'only_check',
                title: 'Only check',
                description: 'Description',
                detail: 'Detail',
                level: 'WARN',
              },
            ],
          };
        },
        async getPerformanceAdvisors() {
          return { lints: [] };
        },
      },
    };
    const { client } = await setupApps({ platform, features: ['debugging'] });
    const { client: withHealth } = await setupApps({ features: ['debugging'] });

    const inputSchemaOf = async (client: Client, name: string) =>
      (await client.listTools()).tools.find((tool) => tool.name === name)
        ?.inputSchema;
    const schema = await inputSchemaOf(client, 'app_paginate_issues');
    expect(schema).toEqual(
      await inputSchemaOf(withHealth, 'app_paginate_issues')
    );
    expect(schema?.properties?.type).toMatchObject({
      enum: ['all', 'security', 'performance', 'health'],
    });
    // The model reads show_issues' schema, so it offers only what get_issues does.
    expect(
      (await inputSchemaOf(client, 'show_issues'))?.properties?.type
    ).toMatchObject({ enum: ['all', 'security', 'performance'] });

    async function pageOf(type: string) {
      const result = await callView(client, 'app_paginate_issues', {
        project_id: 'legacy',
        type,
      });
      expect(result.isError, type).toBeFalsy();
      return JSON.parse(textOf(result)) as IssuesPage;
    }
    const checks = [
      { type: 'security', status: 'complete' },
      { type: 'performance', status: 'complete' },
      {
        type: 'health',
        status: 'unsupported',
        reason: 'Health issues are not supported by this platform',
      },
    ];

    const health = await pageOf('health');
    expect(health).toMatchObject({ issues: [], total: 0, next_cursor: null });
    expect(health.checks).toEqual(checks);

    const all = await pageOf('all');
    expect(all.issues.map(({ id }) => id)).toEqual(['only_check']);
    expect(all.checks).toEqual(checks);
  });

  test('app_paginate_issues caps the limit at 50', async () => {
    const { project } = await createProjectFixture();
    const { client } = await setupApps();

    const result = await callView(client, 'app_paginate_issues', {
      project_id: project.id,
      limit: 51,
    });

    expect(result.isError).toBe(true);
  });
});
