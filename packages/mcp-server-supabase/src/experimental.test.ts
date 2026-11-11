import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ACCESS_TOKEN, API_URL } from '../test/mocks.js';
import { createServerHarness } from '../test/server-harness.js';
import { loadExperimentalExtensions } from './experimental.js';
import { createSupabaseApiPlatform } from './platform/api-platform.js';
import type { SupabasePlatform } from './platform/types.js';

const harness = createServerHarness();
const { setup } = harness;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

const APP_TOOLS = ['show_api_gateway_report', 'get_api_gateway_report_data'];
const UI_URI = 'ui://supabase/api-gateway-report';
const UI_EXTENSION = 'io.modelcontextprotocol/ui';

function platformWith(
  debugging: Partial<NonNullable<SupabasePlatform['debugging']>>
): SupabasePlatform {
  const base = createSupabaseApiPlatform({
    accessToken: ACCESS_TOKEN,
    apiUrl: API_URL,
  });
  return {
    ...base,
    debugging: { ...base.debugging, ...debugging },
  } as SupabasePlatform;
}

describe('loadExperimentalExtensions', () => {
  test('apps: false loads nothing', async () => {
    expect(await loadExperimentalExtensions({ apps: false })).toEqual([]);
    expect(await loadExperimentalExtensions({})).toEqual([]);
  });

  test('apps: true exposes the report tools and UI resource', async () => {
    const queryLogs = vi.fn(async (_projectId: string, _options: unknown) => ({
      result: [],
    }));
    const extensions = await loadExperimentalExtensions({ apps: true });
    const { client } = await setup({
      platform: platformWith({ queryLogs }),
      projectId: 'proj-1',
      extensions,
    });

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(APP_TOOLS));
    const show = tools.find((t) => t.name === APP_TOOLS[0])!;
    expect(show._meta).toMatchObject({ ui: { resourceUri: UI_URI } });
    // Scoped by projectId.
    expect(
      Object.keys(
        (show.inputSchema as { properties: Record<string, unknown> }).properties
      )
    ).toEqual(['time_range']);

    const capabilities = client.getServerCapabilities();
    expect(capabilities).toHaveProperty('resources');
    expect(capabilities?.extensions).toHaveProperty(UI_EXTENSION);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual([UI_URI]);
    const { contents } = await client.readResource({ uri: UI_URI });
    expect(contents[0]).toMatchObject({
      mimeType: 'text/html;profile=mcp-app',
    });

    const result = await client.callTool({
      name: APP_TOOLS[0]!,
      arguments: { time_range: '10m' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    expect(queryLogs).toHaveBeenCalledTimes(2);
    expect(queryLogs.mock.calls[0]![0]).toBe('proj-1');
  });

  test('apps: false leaves tools and capabilities unchanged', async () => {
    const baseline = await setup();
    const withFlagOff = await setup({
      extensions: await loadExperimentalExtensions({ apps: false }),
    });
    expect(await withFlagOff.client.listTools()).toEqual(
      await baseline.client.listTools()
    );
    expect(withFlagOff.client.getServerCapabilities()).toEqual(
      baseline.client.getServerCapabilities()
    );
    const capabilities = withFlagOff.client.getServerCapabilities();
    expect(capabilities).not.toHaveProperty('resources');
    expect(capabilities).not.toHaveProperty('extensions');
  });

  test.each([
    ['no queryLogs', { queryLogs: undefined }],
    [
      'bigquery dialect',
      { logsDialect: 'bigquery' as const, queryLogs: vi.fn() },
    ],
  ])('adds nothing with %s', async (_name, debugging) => {
    const baseline = await setup({ platform: platformWith(debugging) });
    const { client } = await setup({
      platform: platformWith(debugging),
      extensions: await loadExperimentalExtensions({ apps: true }),
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of APP_TOOLS) expect(names).not.toContain(name);
    expect(names).toEqual(
      (await baseline.client.listTools()).tools.map((t) => t.name)
    );
    const capabilities = client.getServerCapabilities();
    expect(capabilities).not.toHaveProperty('resources');
    expect(capabilities).not.toHaveProperty('extensions');
  });

  test('an explicit clickhouse dialect is accepted', async () => {
    const { client } = await setup({
      platform: platformWith({
        logsDialect: 'clickhouse',
        queryLogs: vi.fn(async () => ({ result: [] })),
      }),
      extensions: await loadExperimentalExtensions({ apps: true }),
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(APP_TOOLS));
  });
});
