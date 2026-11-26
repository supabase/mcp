import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import {
  isInputRequiredResult,
  type Client,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createOrganization, createProject } from '../test/mocks.js';
import { callModernTool, createServerHarness } from '../test/server-harness.js';
import { DASHBOARD_URL_META_KEY } from './apps/index.js';
import {
  CREATE_BRANCH_UI_URI,
  CREATE_PROJECT_UI_URI,
  getAppResources,
} from './resources/app-resources.js';

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
