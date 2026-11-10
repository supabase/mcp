import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { tool } from '@supabase/mcp-utils';
import { passthrough, http } from 'msw';
import type { SetupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod/v4';

import {
  ACCESS_TOKEN,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  setupMockApis,
} from '../../test/mocks.js';
import { loadExperimentalExtensions } from '../experimental.js';
import {
  startLocalHttpEntry,
  type LocalHttpEntry,
} from './local-http-entry.js';

vi.mock('../experimental.js', () => ({
  loadExperimentalExtensions: vi.fn(async (opts: { apps?: boolean }) =>
    opts.apps
      ? [
          () => ({
            tools: {
              fake_app_tool: tool({
                description: 'fake',
                annotations: { readOnlyHint: true },
                parameters: z.object({}),
                outputSchema: z.object({}),
                execute: async () => ({}),
              }),
            },
          }),
        ]
      : []
  ),
}));

const AUTH_HEADERS = { Authorization: `Bearer ${ACCESS_TOKEN}` };
let mockServer!: SetupServer;
let entry!: LocalHttpEntry;

beforeEach(async () => {
  mockServer = setupMockApis({ expectedUserAgent: null });
  entry = await startLocalHttpEntry({ port: 0, log: () => {} });
  mockServer.use(
    http.all(`${new URL(entry.url).origin}/*`, () => passthrough())
  );
  vi.mocked(loadExperimentalExtensions).mockClear();
});

afterEach(async () => {
  await entry.close();
  mockServer.close();
});

async function listToolNames(query: string) {
  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    { versionNegotiation: { mode: 'legacy' } }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${entry.url}?${query}`), {
      requestInit: { headers: AUTH_HEADERS },
    })
  );
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

describe('experimental_apps query param', () => {
  test('defaults to false', async () => {
    expect(await listToolNames('')).not.toContain('fake_app_tool');
    expect(loadExperimentalExtensions).toHaveBeenCalledWith({ apps: false });
    expect(loadExperimentalExtensions).not.toHaveBeenCalledWith({ apps: true });
  });

  test('experimental_apps=true reaches loadExperimentalExtensions', async () => {
    expect(await listToolNames('experimental_apps=true')).toContain(
      'fake_app_tool'
    );
    expect(loadExperimentalExtensions).toHaveBeenCalledWith({ apps: true });
  });

  test('experimental_apps=false disables it', async () => {
    expect(await listToolNames('experimental_apps=false')).not.toContain(
      'fake_app_tool'
    );
  });

  test('rejects an invalid value', async () => {
    const response = await fetch(`${entry.url}?experimental_apps=maybe`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
  });
});
