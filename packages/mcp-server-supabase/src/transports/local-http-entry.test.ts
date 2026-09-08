import {
  Client,
  isInputRequiredResult,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type {
  CallToolResult,
  ClientOptions,
  InputRequiredResult,
  VersionNegotiationMode,
} from '@modelcontextprotocol/client';
import { http, HttpResponse, passthrough } from 'msw';
import type { SetupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  ACCESS_TOKEN,
  API_URL,
  createOrganization,
  createProject,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  mockBranches,
  setupMockApis,
} from '../../test/mocks.js';
import {
  type LocalHttpEntry,
  startLocalHttpEntry,
} from './local-http-entry.js';

// https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const AUTH_HEADERS = { Authorization: `Bearer ${ACCESS_TOKEN}` };

let mockServer!: SetupServer;
let entry!: LocalHttpEntry;
let logLines!: string[];
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  mockServer = setupMockApis();
  logLines = [];
  entry = await startLocalHttpEntry({
    port: 0,
    apiUrl: API_URL,
    log: (line) => logLines.push(line),
  });
  // msw intercepts every fetch in-process; let traffic to the entry hit the real socket.
  mockServer.use(
    http.all(`${new URL(entry.url).origin}/*`, () => passthrough())
  );
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  } finally {
    await entry.close();
    mockServer.close();
  }
});

async function connect(
  mode: VersionNegotiationMode,
  query = 'read_only=true',
  options: ClientOptions = {}
) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${entry.url}?${query}`),
    { requestInit: { headers: AUTH_HEADERS } }
  );
  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    { ...options, versionNegotiation: { mode } }
  );
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

describe('startLocalHttpEntry', () => {
  test('serves a modern client', async () => {
    const client = await connect({ pin: MODERN_PROTOCOL_VERSION });

    const { tools } = await client.listTools();
    expect(client.getProtocolEra()).toBe('modern');
    expect(tools.map((tool) => tool.name)).toContain('list_projects');

    const result = await client.callTool({
      name: 'search_docs',
      arguments: {
        graphql_query:
          '{ searchDocs(query: "typescript") { nodes { title href } } }',
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ result: { dummy: true } }) },
    ]);
  });

  test('serves a legacy client', async () => {
    const client = await connect('legacy');

    const { tools } = await client.listTools();
    expect(client.getProtocolEra()).toBe('legacy');
    expect(tools.map((tool) => tool.name)).toContain('list_projects');
  });

  test('logs one line per request', async () => {
    const legacy = await connect('legacy');
    await legacy.listTools();
    const modern = await connect({ pin: MODERN_PROTOCOL_VERSION });
    await modern.listTools();

    expect(logLines).toContainEqual(
      expect.stringMatching(
        /^initialize\s+test-client\/1\.0\.0\s+\(2025-\d\d-\d\d\)$/
      )
    );
    const client = `${MCP_CLIENT_NAME}/${MCP_CLIENT_VERSION}`;
    expect(logLines).toContain(
      `${'tools/list'.padEnd(28)}  ${client.padEnd(24)}  (${MODERN_PROTOCOL_VERSION})`
    );
    expect(logLines.every((line) => !line.includes(ACCESS_TOKEN))).toBe(true);
  });

  test('rejects a request without a bearer token', async () => {
    const response = await fetch(entry.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: 'missing bearer token',
    });
  });

  test('rejects a browser Origin', async () => {
    const response = await fetch(entry.url, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(403);
  });

  test('OAuth mode advertises itself as an OAuth-protected resource', async () => {
    const oauthEntry = await startLocalHttpEntry({
      port: 0,
      apiUrl: API_URL,
      oauthAuthorizationServer: new URL(API_URL),
      log: () => {},
    });
    cleanups.push(() => oauthEntry.close());
    mockServer.use(
      http.all(`${new URL(oauthEntry.url).origin}/*`, () => passthrough())
    );

    const metadataUrl = new URL(
      '/.well-known/oauth-protected-resource/mcp',
      oauthEntry.url
    );
    const metadataResponse = await fetch(metadataUrl);
    await expect(metadataResponse.json()).resolves.toEqual({
      resource: oauthEntry.url,
      authorization_servers: [new URL(API_URL).origin],
      scopes_supported: expect.arrayContaining(['projects:read']),
    });
  });

  test('OAuth mode challenges a request without a bearer token', async () => {
    const oauthEntry = await startLocalHttpEntry({
      port: 0,
      apiUrl: API_URL,
      oauthAuthorizationServer: new URL(API_URL),
      log: () => {},
    });
    cleanups.push(() => oauthEntry.close());
    mockServer.use(
      http.all(`${new URL(oauthEntry.url).origin}/*`, () => passthrough())
    );

    const response = await fetch(oauthEntry.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', oauthEntry.url).href}"`
    );
  });

  test('OAuth mode accepts each client bringing its own bearer token', async () => {
    const oauthEntry = await startLocalHttpEntry({
      port: 0,
      apiUrl: API_URL,
      oauthAuthorizationServer: new URL(API_URL),
      log: () => {},
    });
    cleanups.push(() => oauthEntry.close());
    const seen: Array<string | null> = [];
    mockServer.use(
      http.all(`${new URL(oauthEntry.url).origin}/*`, () => passthrough()),
      http.get(`${API_URL}/v1/projects`, ({ request }) => {
        seen.push(request.headers.get('authorization'));
        return HttpResponse.json([]);
      })
    );

    for (const token of [`${ACCESS_TOKEN}-a`, `${ACCESS_TOKEN}-b`]) {
      const client = new Client(
        { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
        { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } }
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(oauthEntry.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        })
      );
      cleanups.push(() => client.close());
      await client.callTool({ name: 'list_projects', arguments: {} });
    }

    expect(seen).toEqual([
      `Bearer ${ACCESS_TOKEN}-a`,
      `Bearer ${ACCESS_TOKEN}-b`,
    ]);
  });

  test('sends a form-capable client a cost elicitation', async () => {
    const client = await connect(
      { pin: MODERN_PROTOCOL_VERSION },
      'features=account,branching',
      {
        capabilities: { elicitation: { form: {} } },
        inputRequired: { autoFulfill: false },
      }
    );
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

    const result = (await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'create_branch',
          arguments: { project_id: project.id, name: 'feature' },
        },
      },
      { allowInputRequired: true }
    )) as CallToolResult | InputRequiredResult;

    if (!isInputRequiredResult(result)) {
      throw new Error('expected an input_required result');
    }
    expect(result.inputRequests?.confirm_cost).toMatchObject({
      method: 'elicitation/create',
      params: { mode: 'form' },
    });
    expect(mockBranches.size).toBe(0);
    expect(logLines.at(-1)).toBe(
      `${'tools/call create_branch'.padEnd(28)}  ${`${MCP_CLIENT_NAME}/${MCP_CLIENT_VERSION}`.padEnd(24)}  (${MODERN_PROTOCOL_VERSION})`
    );
  });
});
