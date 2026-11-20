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
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  ACCESS_TOKEN,
  API_URL,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  mockContentApiSchemaLoadCount,
  setupMockApis,
} from '../../test/mocks.js';
import {
  CONTENT_API_SCHEMA_TTL_MS,
  invalidateContentApiSchemaCache,
} from '../content-api/index.js';
import { createSupabaseApiPlatform } from '../platform/api-platform.js';
import { createSupabaseMcpHandler } from './http.js';

// https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const MCP_ENDPOINT = new URL('https://mcp.test');

let mockServer!: SetupServer;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  mockServer = setupMockApis();
  // The schema cache is process-wide, so it would otherwise leak across tests.
  invalidateContentApiSchemaCache();
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

  test('fetches the docs schema once across independently created handlers', async () => {
    expect(mockContentApiSchemaLoadCount.value).toBe(0);

    // Each handler is what the hosted deployment builds per request.
    for (let i = 0; i < 3; i++) {
      const { client } = await setupModernClient();
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('search_docs');
    }

    expect(mockContentApiSchemaLoadCount.value).toBe(1);
  });

  test('stamps the schema TTL and a private cacheScope on 2026-07-28 tools/list', async () => {
    const { client } = await setupModernClient();

    const result = await client.listTools();

    expect(result).toMatchObject({
      ttlMs: CONTENT_API_SCHEMA_TTL_MS,
      cacheScope: 'private',
    });
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
