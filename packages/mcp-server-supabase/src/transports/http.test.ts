import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { http, HttpResponse } from 'msw';
import type { SetupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ACCESS_TOKEN,
  API_URL,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  setupMockApis,
} from '../../test/mocks.js';
import { createSupabaseApiPlatform } from '../platform/api-platform.js';
import { createSupabaseMcpHandler } from './http.js';

// https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const MCP_ENDPOINT = new URL('https://mcp.test');

let mockServer!: SetupServer;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  mockServer = setupMockApis();
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  } finally {
    mockServer.close();
  }
});

function createHandler() {
  const handler = createSupabaseMcpHandler({
    platform: createSupabaseApiPlatform({
      accessToken: ACCESS_TOKEN,
      apiUrl: API_URL,
    }),
    readOnly: true,
  });

  cleanups.push(() => handler.close());

  return handler;
}

async function setupModernClient() {
  const handler = createHandler();
  const transport = new StreamableHTTPClientTransport(MCP_ENDPOINT, {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    {
      name: MCP_CLIENT_NAME,
      version: MCP_CLIENT_VERSION,
    },
    {
      capabilities: {},
      versionNegotiation: {
        mode: { pin: MODERN_PROTOCOL_VERSION },
      },
    }
  );

  await client.connect(transport);
  cleanups.push(() => client.close());

  return { client, handler };
}

function jsonRequest(body: unknown) {
  return new Request(MCP_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

describe('createSupabaseMcpHandler', () => {
  test('serves discovery and tools/list to a client pinned to 2026-07-28', async () => {
    const { client } = await setupModernClient();

    const { tools } = await client.listTools();

    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);
    expect(client.getDiscoverResult()?.supportedVersions).toContain(
      MODERN_PROTOCOL_VERSION
    );
    expect(tools.map((tool) => tool.name)).toContain('list_projects');
  });

  test('calls the same registered read-only business tool', async () => {
    const { client } = await setupModernClient();

    const result = await client.callTool({
      name: 'search_docs',
      arguments: {
        graphql_query:
          '{ searchDocs(query: "typescript") { nodes { title href } } }',
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ result: { dummy: true } }),
      },
    ]);
  });

  test('rejects a claim-less legacy request', async () => {
    const handler = createHandler();

    const response = await handler.fetch(
      jsonRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32022,
        data: { supported: [MODERN_PROTOCOL_VERSION] },
      },
    });
  });

  test('returns a modern validation error for a malformed claimed envelope', async () => {
    const handler = createHandler();

    const response = await handler.fetch(
      jsonRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          },
        },
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: -32602,
        data: {
          envelope: {
            key: CLIENT_CAPABILITIES_META_KEY,
            problem: 'missing',
          },
        },
      },
    });
  });

  test('reports transport-level validation errors through the optional error callback', async () => {
    const onerror = vi.fn();
    const handler = createSupabaseMcpHandler(
      {
        platform: createSupabaseApiPlatform({
          accessToken: ACCESS_TOKEN,
          apiUrl: API_URL,
        }),
        readOnly: true,
      },
      { onerror }
    );
    cleanups.push(() => handler.close());

    const response = await handler.fetch(
      new Request(MCP_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'execute_sql',
          'Mcp-Protocol-Version': '2025-01-01',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'execute_sql',
            arguments: {
              project_id: 'project-123',
              query: 'SELECT 1',
            },
          },
        }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      error: {
        code: -32022,
        message: 'Unsupported protocol version: 2025-01-01',
      },
    });
    expect(onerror).toHaveBeenCalledWith(expect.any(Error));
  });

  test('close releases an in-flight request', async () => {
    const requestStarted = deferred();
    const releaseRequest = deferred();
    mockServer.use(
      http.get(`${API_URL}/v1/projects`, async () => {
        requestStarted.resolve();
        await releaseRequest.promise;
        return HttpResponse.json([]);
      })
    );
    const { client, handler } = await setupModernClient();
    const callOutcome = client
      .callTool({ name: 'list_projects', arguments: {} })
      .then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error })
      );

    try {
      await requestStarted.promise;
      await handler.close();

      await expect(callOutcome).resolves.toMatchObject({
        status: 'rejected',
      });
    } finally {
      releaseRequest.resolve();
    }
  });
});
