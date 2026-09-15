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
import { http, passthrough } from 'msw';
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
  mockContentApi,
  mockManagementApi,
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
  // Modern HTTP requests do not run the legacy initialization hook that sets
  // the User-Agent. Keep authorization and API routes, not that legacy assertion.
  const [authorization, _legacyUserAgent, ...routes] = mockManagementApi;
  mockServer.resetHandlers(...mockContentApi, authorization!, ...routes);
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

function toolOutput(result: CallToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const [content] = result.content;
  if (content?.type !== 'text') throw new Error('expected a text tool result');
  return JSON.parse(content.text);
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

  test.each([
    'create_project',
    'create_branch',
    ' create_project, ,create_branch ',
  ])('uses legacy confirmation only for skipped tools: %s', async (skip) => {
    const client = await connect(
      { pin: MODERN_PROTOCOL_VERSION },
      `features=account,branching&skip_elicitations=${encodeURIComponent(skip)}`,
      {
        capabilities: { elicitation: { form: {} } },
        inputRequired: { autoFulfill: false },
      }
    );
    const org = await createOrganization({
      name: 'Paid Org',
      plan: 'pro',
      allowed_release_channels: ['ga'],
    });
    const project = await createProject({
      name: 'Existing Project',
      region: 'us-east-1',
      organization_id: org.id,
    });
    project.status = 'ACTIVE_HEALTHY';
    const { tools } = await client.listTools();

    for (const type of ['project', 'branch'] as const) {
      const name = `create_${type}` as const;
      const skipped = skip.includes(name);
      const tool = tools.find((tool) => tool.name === name)!;
      expect(
        tool.inputSchema.required?.includes('confirm_cost_id') ?? false
      ).toBe(skipped);
      const args =
        type === 'project'
          ? {
              name: 'New Project',
              organization_id: org.id,
              region: 'us-east-1',
            }
          : { name: 'feature', project_id: project.id };
      const result = (await client.request(
        { method: 'tools/call', params: { name, arguments: args } },
        { allowInputRequired: true }
      )) as CallToolResult | InputRequiredResult;
      if (!skipped) {
        expect(isInputRequiredResult(result), JSON.stringify(result)).toBe(
          true
        );
        expect(
          (result as InputRequiredResult).inputRequests?.confirm_cost
        ).toMatchObject({
          method: 'elicitation/create',
          params: { mode: 'form' },
        });
        continue;
      }

      // Skipping the prompt does not waive the existing cost confirmation.
      expect(isInputRequiredResult(result)).toBe(false);
      expect((result as CallToolResult).isError).toBe(true);
      const cost = await client.callTool({
        name: 'get_cost',
        arguments: { type, organization_id: org.id },
      });
      const confirmed = await client.callTool({
        name: 'confirm_cost',
        arguments: toolOutput(cost),
      });
      const created = await client.callTool({
        name,
        arguments: {
          ...args,
          confirm_cost_id: toolOutput(confirmed).confirmation_id,
        },
      });
      expect(toolOutput(created)).toMatchObject({ name: args.name });
    }

    // The same process must not retain a previous request's skips.
    const unchanged = await connect(
      { pin: MODERN_PROTOCOL_VERSION },
      'features=account,branching',
      { capabilities: { elicitation: { form: {} } } }
    );
    const defaults = await unchanged.listTools();
    expect(defaults.tools.map((tool) => tool.name)).not.toContain(
      'confirm_cost'
    );
    const again = await client.listTools();
    expect(again.tools).toEqual(tools);
  });

  test.each(['', ' , '])(
    'keeps elicitation defaults for blank CSV %j',
    async (skip) => {
      const client = await connect(
        { pin: MODERN_PROTOCOL_VERSION },
        `features=account,branching&skip_elicitations=${encodeURIComponent(skip)}`,
        { capabilities: { elicitation: { form: {} } } }
      );
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).not.toContain('confirm_cost');
      for (const name of ['create_project', 'create_branch']) {
        expect(
          tools.find((tool) => tool.name === name)?.inputSchema.properties
        ).not.toHaveProperty('confirm_cost_id');
      }
    }
  );

  test.each(['unknown', 'Create_Project', 'execute_sql', 'apply_migration'])(
    'rejects unsupported skip name %s over HTTP',
    async (skip) => {
      const response = await fetch(`${entry.url}?skip_elicitations=${skip}`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error');
    }
  );

  test.each([
    'skip_elicitations=create_project&skip_elicitations=create_branch',
    'skip_elicitations=create_project&skip_elicitations=create_project',
    'skip_elicitations=&skip_elicitations=',
    'skip_elicitations=execute_sql&skip_elicitations=create_branch',
    'skip_elicitations[]=create_branch',
    'skip_elicitations[0]=create_project',
    'skip_elicitations[tool]=create_branch',
    'skip_elicitations%5B%5D=create_branch',
    'skip_elicitations[tool][name]=create_project',
    'skip_elicitations=create_project&skip_elicitations[]=create_branch',
  ])('rejects non-string skip query shapes: %s', async (query) => {
    const response = await fetch(`${entry.url}?${query}`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
  });

  test('preserves last-value normalization for unrelated query parameters', async () => {
    const client = await connect(
      { pin: MODERN_PROTOCOL_VERSION },
      'features=database&features=account,branching&read_only=true&read_only=false&skip_elicitations=create_branch',
      { capabilities: { elicitation: { form: {} } } }
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('execute_sql');
    expect(
      tools.find((tool) => tool.name === 'create_project')?.inputSchema
        .properties
    ).not.toHaveProperty('confirm_cost_id');
    expect(
      tools.find((tool) => tool.name === 'create_branch')?.inputSchema.required
    ).toContain('confirm_cost_id');
  });

  test('skips cannot restore tools excluded by read-only mode', async () => {
    const client = await connect(
      { pin: MODERN_PROTOCOL_VERSION },
      'features=account,branching&read_only=true&skip_elicitations=create_project,create_branch',
      { capabilities: { elicitation: { form: {} } } }
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('create_project');
    expect(tools.map((tool) => tool.name)).not.toContain('create_branch');
    const result = await client.callTool({
      name: 'create_project',
      arguments: {
        name: 'Forbidden',
        organization_id: 'org',
        region: 'us-east-1',
        confirm_cost_id: 'invalid',
      },
    });
    expect(result.isError).toBe(true);
  });
});
