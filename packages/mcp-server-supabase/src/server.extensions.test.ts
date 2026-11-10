import { tool } from '@supabase/mcp-utils';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod/v4';
import { createServerHarness } from '../test/server-harness.js';
import { createSupabaseApiPlatform } from './platform/api-platform.js';
import { ACCESS_TOKEN, API_URL } from '../test/mocks.js';
import {
  createSupabaseMcpServer,
  type SupabaseExtensionEnv,
  type SupabaseExtensionFactory,
} from './server.js';

const harness = createServerHarness();
const { setup, setupModern } = harness;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

const UI_URI = 'ui://test/report';
const UI_MIME = 'text/html;profile=mcp-app';
const UI_EXTENSION = 'io.modelcontextprotocol/ui';

function createFakeExtension(envs: SupabaseExtensionEnv[] = []) {
  const factory: SupabaseExtensionFactory = (env) => {
    envs.push(env);
    return {
      tools: {
        show_fake_report: tool({
          description: 'Shows a fake report',
          annotations: { title: 'Fake report', readOnlyHint: true },
          parameters: z.object({ range: z.string() }),
          outputSchema: z.object({ ok: z.boolean() }),
          _meta: { ui: { resourceUri: UI_URI } },
          execute: async ({ range }) => ({
            content: [{ type: 'text' as const, text: `report ${range}` }],
            structuredContent: { ok: true },
          }),
        }),
        write_fake_thing: tool({
          description: 'Writes a fake thing',
          annotations: { title: 'Fake write', readOnlyHint: false },
          parameters: z.object({}),
          outputSchema: z.object({ ok: z.boolean() }),
          execute: async () => ({ ok: true }),
        }),
      },
      resources: [
        {
          uri: UI_URI,
          name: 'fake-report',
          mimeType: UI_MIME,
          _meta: { ui: { prefersBorder: true } },
          read: async (uri: string) => ({
            uri,
            mimeType: UI_MIME,
            text: '<html></html>',
            _meta: { ui: { csp: {} } },
          }),
        },
      ],
      extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME] } },
    };
  };
  return factory;
}

function withoutCapabilities(): SupabaseExtensionFactory {
  const factory = createFakeExtension();
  return (env) => ({ tools: factory(env).tools });
}

describe('extensions', () => {
  test('without extensions, resources and extensions are not advertised', async () => {
    const { client } = await setup();

    const capabilities = client.getServerCapabilities();
    expect(capabilities).toHaveProperty('tools');
    expect(capabilities).not.toHaveProperty('resources');
    expect(capabilities).not.toHaveProperty('extensions');

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('show_fake_report');
    expect(tools.every((t) => !('_meta' in t))).toBe(true);
  });

  test('an empty extension list changes nothing', async () => {
    const baseline = await setup();
    const baselineTools = await baseline.client.listTools();
    const withEmpty = await setup({ extensions: [] });

    expect(await withEmpty.client.listTools()).toEqual(baselineTools);
    expect(withEmpty.client.getServerCapabilities()).toEqual(
      baseline.client.getServerCapabilities()
    );
  });

  test('lists extension tools with _meta and declares the capability', async () => {
    const envs: SupabaseExtensionEnv[] = [];
    const { client } = await setup({
      projectId: 'proj-1',
      extensions: [createFakeExtension(envs)],
    });

    const { tools } = await client.listTools();
    const report = tools.find((t) => t.name === 'show_fake_report');
    expect(report?._meta).toEqual({ ui: { resourceUri: UI_URI } });
    expect(tools.map((t) => t.name)).toContain('write_fake_thing');

    const capabilities = client.getServerCapabilities();
    expect(capabilities).toHaveProperty('resources');
    expect(capabilities?.extensions).toEqual({
      [UI_EXTENSION]: { mimeTypes: [UI_MIME] },
    });

    expect(envs).toHaveLength(1);
    expect(envs[0]).toMatchObject({ projectId: 'proj-1', readOnly: false });
    expect(envs[0]!.platform).toBeDefined();
  });

  test('extension tools are not gated by features', async () => {
    const { client } = await setup({
      features: ['docs'],
      extensions: [createFakeExtension()],
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('show_fake_report');
  });

  test('read-only mode hides write extension tools only', async () => {
    const envs: SupabaseExtensionEnv[] = [];
    const { client } = await setup({
      readOnly: true,
      extensions: [createFakeExtension(envs)],
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('show_fake_report');
    expect(names).not.toContain('write_fake_thing');
    expect(envs[0]!.readOnly).toBe(true);
  });

  test('lists and reads extension resources', async () => {
    const { client } = await setup({ extensions: [createFakeExtension()] });

    const { resources } = await client.listResources();
    expect(resources).toEqual([
      expect.objectContaining({
        uri: UI_URI,
        mimeType: UI_MIME,
        _meta: { ui: { prefersBorder: true } },
      }),
    ]);

    const { contents } = await client.readResource({ uri: UI_URI });
    expect(contents).toEqual([
      expect.objectContaining({
        uri: UI_URI,
        mimeType: UI_MIME,
        text: '<html></html>',
        _meta: { ui: { csp: {} } },
      }),
    ]);
  });

  test('extension tools are callable and keep structuredContent', async () => {
    const { client } = await setup({ extensions: [createFakeExtension()] });
    const result = await client.callTool({
      name: 'show_fake_report',
      arguments: { range: '1h' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'report 1h' }]);
    expect(result.structuredContent).toEqual({ ok: true });
  });

  test('works over the modern protocol', async () => {
    const { client } = await setupModern({
      readOnly: true,
      extensions: [createFakeExtension()],
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('show_fake_report');
    expect(tools.map((t) => t.name)).not.toContain('write_fake_thing');
    expect(client.getServerCapabilities()?.extensions).toHaveProperty(
      UI_EXTENSION
    );
  });

  test('an extension tool colliding with a core tool throws', async () => {
    const colliding: SupabaseExtensionFactory = () => ({
      tools: {
        list_projects: tool({
          description: 'Collides',
          parameters: z.object({}),
          outputSchema: z.object({}),
          execute: async () => ({}),
        }),
      },
    });
    expect(() =>
      createSupabaseMcpServer({
        platform: createSupabaseApiPlatform({
          accessToken: ACCESS_TOKEN,
          apiUrl: API_URL,
        }),
        extensions: [colliding],
      })
    ).toThrow(/conflicts with a core tool/);
  });

  test('two extensions with the same tool name throw', () => {
    const platform = createSupabaseApiPlatform({
      accessToken: ACCESS_TOKEN,
      apiUrl: API_URL,
    });
    expect(() =>
      createSupabaseMcpServer({
        platform,
        extensions: [withoutCapabilities(), withoutCapabilities()],
      })
    ).toThrow(/conflicts/);
  });

  test('duplicate extension capability IDs throw', () => {
    const platform = createSupabaseApiPlatform({
      accessToken: ACCESS_TOKEN,
      apiUrl: API_URL,
    });
    const a: SupabaseExtensionFactory = () => ({ extensions: { x: {} } });
    expect(() =>
      createSupabaseMcpServer({ platform, extensions: [a, a] })
    ).toThrow(/capability "x"/);
  });
});
