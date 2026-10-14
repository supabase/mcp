import { once } from 'node:events';
import { createServer } from 'node:net';
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
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { http, HttpResponse, passthrough } from 'msw';
import type { SetupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ACCESS_TOKEN,
  API_URL,
  createOrganization,
  createProject,
  createProjectFixture,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  mockBranches,
  setupMockApis,
} from '../../test/mocks.js';
import { CURRENT_ELICITATION_TOOLS } from '../types.js';
import {
  describeRequest,
  type LocalHttpEntry,
  startLocalHttpEntry,
  type LocalHttpEntryOptions,
} from './local-http-entry.js';

// https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const AUTH_HEADERS = { Authorization: `Bearer ${ACCESS_TOKEN}` };

/** Reserves an ephemeral port or proves a known port is free, then releases it. */
async function bindAndReleasePort(port = 0): Promise<number> {
  const probe = createServer();
  probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  probe.close();
  await once(probe, 'close');
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return address.port;
}

let mockServer!: SetupServer;
let entry!: LocalHttpEntry;
let logLines!: string[];
const cleanups: Array<() => Promise<void>> = [];

async function startEntry(
  options: Pick<LocalHttpEntryOptions, 'apiUrl' | 'secretUrlTemplate'> = {}
) {
  const started = await startLocalHttpEntry({
    port: 0,
    log: (line) => logLines.push(line),
    ...options,
  });
  const apiOrigin = new URL(options.apiUrl ?? API_URL).origin;
  // Let intercepted MCP traffic reach the real loopback socket.
  mockServer.use(
    http.all(`${new URL(started.url).origin}/*`, () => passthrough()),
    // Modern HTTP has no legacy initialize User-Agent to assert.
    http.get(`${apiOrigin}/v1/projects/:projectId/secrets`, ({ request }) =>
      request.headers.get('authorization') === AUTH_HEADERS.Authorization
        ? HttpResponse.json([])
        : HttpResponse.json({ message: 'Unauthorized' }, { status: 401 })
    )
  );
  return started;
}

beforeEach(async () => {
  // Modern stateless requests do not run the platform's onInitialize telemetry.
  mockServer = setupMockApis({ expectedUserAgent: null });
  logLines = [];
  entry = await startEntry();
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  } finally {
    vi.restoreAllMocks();
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
        /^initialize\s+test-client\/1\.0\.0\s+\(2025-\d\d-\d\d\)/
      )
    );
    const client = `${MCP_CLIENT_NAME}/${MCP_CLIENT_VERSION}`;
    expect(logLines).toContain(
      `${'tools/list'.padEnd(28)}  ${client.padEnd(24)}  (${MODERN_PROTOCOL_VERSION})`
    );
    expect(logLines.every((line) => !line.includes(ACCESS_TOKEN))).toBe(true);
  });

  test('logs only the current request elicitation subtree', () => {
    const sensitive = 'SENSITIVE_FIXTURE_MUST_NOT_APPEAR';
    for (const elicitation of [
      undefined,
      {},
      { form: {} },
      { url: {} },
      { form: {}, url: {} },
    ]) {
      const capabilities = {
        ...(elicitation === undefined ? {} : { elicitation }),
        experimental: { private: { marker: sensitive } },
      };
      const initialize = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
          capabilities,
        },
      };
      const call = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'create_edge_function_secret',
          arguments: { name: sensitive, value: sensitive },
          requestState: sensitive,
          inputResponses: {
            store_secret: { action: 'accept', content: { value: sensitive } },
          },
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
            [CLIENT_CAPABILITIES_META_KEY]: capabilities,
            private: sensitive,
          },
        },
      };
      for (const request of [initialize, call]) {
        const line = describeRequest(request);
        expect(line.split('  elicitation=')[1]).toBe(
          JSON.stringify(elicitation) ?? 'absent'
        );
        expect(line).not.toContain(sensitive);
      }
    }

    const legacyCall = describeRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'create_edge_function_secret', arguments: {} },
    });
    expect(legacyCall).toContain('(legacy)  elicitation=absent');
  });

  test.each([
    ...CURRENT_ELICITATION_TOOLS,
    'create_edge_function_secret',
  ] as const)(
    'keeps the diagnostic elicitation suffix for %s tool calls',
    (name) => {
      const line = describeRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name,
          arguments: {},
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } },
          },
        },
      });
      expect(line).toContain('elicitation=');
    }
  );

  test.each(['list_projects', 'get_cost', 'constructor'])(
    'omits the diagnostic elicitation suffix for unrelated %s tool calls',
    (name) => {
      const line = describeRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name,
          arguments: {},
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } },
          },
        },
      });
      expect(line).toContain(`tools/call ${name}`);
      expect(line).not.toContain('elicitation=');
    }
  );

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

  test.each([
    {
      label: 'omitted API and template',
      apiUrl: undefined,
      secretUrlTemplate: undefined,
      expectedUrl:
        'https://supabase.com/dashboard/mcp/secrets?ref=project&name=HTTP_SECRET',
    },
    {
      label: 'canonical green API',
      apiUrl: 'HTTPS://API.SUPABASE.GREEN:443/',
      secretUrlTemplate: undefined,
      expectedUrl:
        'https://supabase.green/dashboard/mcp/secrets?ref=project&name=HTTP_SECRET',
    },
    {
      label: 'explicit override of the green default',
      apiUrl: 'https://api.supabase.green',
      secretUrlTemplate: 'https://example.com/secrets/{ref}?key={name}',
      expectedUrl: 'https://example.com/secrets/project?key=HTTP_SECRET',
    },
    {
      label: 'custom API with an explicit template',
      apiUrl: 'http://127.0.0.1:9999',
      secretUrlTemplate: 'http://127.0.0.1:8082/secrets/{ref}?key={name}',
      expectedUrl: 'http://127.0.0.1:8082/secrets/project?key=HTTP_SECRET',
    },
  ])('uses $label for a scoped URL continuation', async (options) => {
    await entry.close();
    entry = await startEntry({
      apiUrl: options.apiUrl,
      secretUrlTemplate: options.secretUrlTemplate,
    });
    const client = await connect(
      { pin: MODERN_PROTOCOL_VERSION },
      'project_ref=project&features=functions&read_only=false',
      {
        capabilities: { elicitation: { url: {} } },
        inputRequired: { autoFulfill: false },
      }
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain(
      'create_edge_function_secret'
    );
    const params = {
      name: 'create_edge_function_secret',
      arguments: { name: 'HTTP_SECRET' },
    };
    const first = (await client.request(
      { method: 'tools/call', params },
      { allowInputRequired: true }
    )) as CallToolResult | InputRequiredResult;
    if (!isInputRequiredResult(first)) {
      throw new Error('expected an input_required result');
    }
    expect(first.inputRequests?.store_secret).toMatchObject({
      method: 'elicitation/create',
      params: { mode: 'url', url: options.expectedUrl },
    });
    const cancelled = (await client.request({
      method: 'tools/call',
      params: {
        ...params,
        requestState: first.requestState,
        inputResponses: { store_secret: { action: 'cancel' } },
      },
    })) as CallToolResult;
    expect(cancelled.structuredContent).toEqual({ status: 'cancelled' });
  });

  test('requires an explicit template for an unknown API origin', async () => {
    await expect(
      startLocalHttpEntry({
        port: 0,
        apiUrl: 'https://api.supabase.green.example.com',
      })
    ).rejects.toBeInstanceOf(Error);
  });

  test.each([
    { label: 'an explicitly empty template', value: '' },
    {
      label: 'a relative template with both placeholders',
      value: '/dashboard/mcp/secrets?ref={ref}&name={name}',
    },
    {
      label: 'an absolute template missing the name placeholder',
      value: 'https://example.com/secrets?ref={ref}',
    },
    {
      label: 'an absolute template missing the ref placeholder',
      value: 'https://example.com/secrets?name={name}',
    },
  ])(
    'rejects a malformed resolved secret URL template ($label) before binding a listener',
    async ({ value }) => {
      const port = await bindAndReleasePort();
      let started: LocalHttpEntry | undefined;
      let caught: unknown;
      try {
        started = await startLocalHttpEntry({ port, secretUrlTemplate: value });
      } catch (error) {
        caught = error;
      } finally {
        // Close an unexpectedly successful startup so a failing assertion
        // cannot leave a listener behind.
        if (started) await started.close();
      }
      expect(caught).toBeInstanceOf(Error);
      await bindAndReleasePort(port);
    }
  );

  test.each<{
    label: string;
    capabilities: NonNullable<ClientOptions['capabilities']>;
    listed: boolean;
    mode?: VersionNegotiationMode;
  }>([
    { label: 'absent elicitation', capabilities: {}, listed: false },
    {
      label: 'empty elicitation modes',
      capabilities: { elicitation: {} },
      listed: false,
    },
    {
      label: 'form-only elicitation',
      capabilities: { elicitation: { form: {} } },
      listed: false,
    },
    {
      label: 'form and URL elicitation',
      capabilities: { elicitation: { form: {}, url: {} } },
      listed: true,
    },
    {
      label: 'legacy without elicitation',
      mode: 'legacy',
      capabilities: {},
      listed: false,
    },
  ])(
    'keeps secret tool visibility request-scoped for $label',
    async ({ mode, capabilities, listed }) => {
      const query = 'project_ref=project&features=functions&read_only=false';
      const urlClient = await connect({ pin: MODERN_PROTOCOL_VERSION }, query, {
        capabilities: { elicitation: { url: {} } },
      });
      const { tools: urlTools } = await urlClient.listTools();
      expect(urlTools.map((tool) => tool.name)).toContain(
        'create_edge_function_secret'
      );

      const client = await connect(
        mode ?? { pin: MODERN_PROTOCOL_VERSION },
        query,
        { capabilities }
      );
      const { tools } = await client.listTools();
      expect(tools).toEqual(
        listed
          ? urlTools
          : urlTools.filter(
              (tool) => tool.name !== 'create_edge_function_secret'
            )
      );
      expect((await urlClient.listTools()).tools).toEqual(urlTools);
    }
  );

  test.each(['features=functions&read_only=true', 'features=database'])(
    'does not expose secret collection with %s',
    async (query) => {
      const client = await connect({ pin: MODERN_PROTOCOL_VERSION }, query, {
        capabilities: { elicitation: { url: {} } },
      });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).not.toContain(
        'create_edge_function_secret'
      );
    }
  );

  test('keeps URL capability and metadata permission checks on the HTTP path', async () => {
    const unsupported = await connect(
      { pin: MODERN_PROTOCOL_VERSION },
      'project_ref=project&features=functions'
    );
    const params = {
      name: 'create_edge_function_secret',
      arguments: { name: 'HTTP_SECRET' },
    };
    const unsupportedResult = await unsupported.callTool(params);
    expect(unsupportedResult.structuredContent).toEqual({
      status: 'unsupported_client',
    });
    mockServer.use(
      http.get(`${API_URL}/v1/projects/project/secrets`, () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 })
      )
    );
    const client = await connect(
      { pin: MODERN_PROTOCOL_VERSION },
      'project_ref=project&features=functions',
      {
        capabilities: { elicitation: { url: {} } },
        inputRequired: { autoFulfill: false },
      }
    );
    const denied = (await client.request(
      { method: 'tools/call', params },
      { allowInputRequired: true }
    )) as CallToolResult | InputRequiredResult;
    expect(isInputRequiredResult(denied)).toBe(false);
    expect(denied).toMatchObject({ isError: true });
  });

  test('expires shared HTTP cost and secret state after two minutes', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const client = await connect(
      { pin: MODERN_PROTOCOL_VERSION },
      'features=account,branching,functions',
      {
        capabilities: { elicitation: { form: {}, url: {} } },
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
    const secret = (await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'create_edge_function_secret',
          arguments: { project_id: project.id, name: 'HTTP_SECRET' },
        },
      },
      { allowInputRequired: true }
    )) as CallToolResult | InputRequiredResult;
    expect(secret).toMatchObject({
      inputRequests: {
        store_secret: { method: 'elicitation/create', params: { mode: 'url' } },
      },
    });
    if (!isInputRequiredResult(secret)) {
      throw new Error('expected an input_required result');
    }
    clock.mockReturnValue(now + 121_000);
    for (const continuation of [
      {
        name: 'create_branch',
        arguments: { project_id: project.id, name: 'feature' },
        requestState: result.requestState,
        inputResponses: { confirm_cost: { action: 'cancel' } },
      },
      {
        name: 'create_edge_function_secret',
        arguments: { project_id: project.id, name: 'HTTP_SECRET' },
        requestState: secret.requestState,
        inputResponses: { store_secret: { action: 'cancel' } },
      },
    ]) {
      await expect(
        client.request(
          { method: 'tools/call', params: continuation },
          { allowInputRequired: true }
        )
      ).rejects.toMatchObject({ code: -32602 });
    }
  });

  test.each(['execute_sql', 'apply_migration'] as const)(
    '%s confirms destructive SQL for form clients and preserves no-form execution',
    async (tool) => {
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
      cleanups.push(() => project.destroy());
      project.status = 'ACTIVE_HEALTHY';
      await project.db.exec('create table films (id int)');

      const query = `features=database&read_only=false&project_ref=${project.id}`;
      const formClient = await connect(
        { pin: MODERN_PROTOCOL_VERSION },
        query,
        {
          capabilities: { elicitation: { form: {} } },
          inputRequired: { autoFulfill: false },
        }
      );
      const params = {
        name: tool,
        arguments: {
          query: 'drop table films;',
          ...(tool === 'apply_migration' ? { name: 'drop_films' } : {}),
        },
      };
      const first = (await formClient.request(
        { method: 'tools/call', params },
        { allowInputRequired: true }
      )) as CallToolResult | InputRequiredResult;

      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }
      expect(first.inputRequests?.confirm_destructive).toMatchObject({
        method: 'elicitation/create',
        params: { mode: 'form' },
      });
      expect(
        (await project.db.query("select to_regclass('public.films') as name"))
          .rows
      ).toEqual([{ name: 'films' }]);
      expect(project.migrations).toEqual([]);

      const accepted = (await formClient.request(
        {
          method: 'tools/call',
          params: {
            ...params,
            requestState: first.requestState,
            inputResponses: {
              confirm_destructive: { action: 'accept', content: {} },
            },
          },
        },
        { allowInputRequired: true }
      )) as CallToolResult | InputRequiredResult;

      if (isInputRequiredResult(accepted)) {
        throw new Error(
          'expected accepted SQL to execute without re-prompting'
        );
      }
      expect(accepted.isError).toBeFalsy();
      expect(
        (await project.db.query("select to_regclass('public.films') as name"))
          .rows
      ).toEqual([{ name: null }]);

      await project.db.exec('create table films (id int)');
      const noFormClient = await connect(
        { pin: MODERN_PROTOCOL_VERSION },
        query,
        { inputRequired: { autoFulfill: false } }
      );
      const unconfirmed = (await noFormClient.request(
        { method: 'tools/call', params },
        { allowInputRequired: true }
      )) as CallToolResult | InputRequiredResult;

      if (isInputRequiredResult(unconfirmed)) {
        throw new Error('expected no-form SQL to execute without elicitation');
      }
      expect(unconfirmed.isError).toBeFalsy();
      expect(
        (await project.db.query("select to_regclass('public.films') as name"))
          .rows
      ).toEqual([{ name: null }]);
    }
  );

  test.each([
    '',
    ' , ',
    'execute_sql',
    'apply_migration',
    'create_project,create_branch,execute_sql,apply_migration',
  ])('isolates SQL skips and preserves cost eligibility: %j', async (skip) => {
    const org = await createOrganization({
      name: 'My Org',
      plan: 'pro',
      allowed_release_channels: ['ga'],
    });
    const project = await createProject({
      name: 'Project 1',
      region: 'us-east-1',
      organization_id: org.id,
    });
    cleanups.push(() => project.destroy());
    project.status = 'ACTIVE_HEALTHY';
    const client = await connect(
      { pin: MODERN_PROTOCOL_VERSION },
      `features=account,branching,database&skip_elicitations=${encodeURIComponent(skip)}`,
      {
        capabilities: { elicitation: { form: {} } },
        inputRequired: { autoFulfill: false },
      }
    );

    for (const tool of ['execute_sql', 'apply_migration'] as const) {
      await project.db.exec('create table films (id int)');
      const result = (await client.request(
        {
          method: 'tools/call',
          params: {
            name: tool,
            arguments: {
              project_id: project.id,
              query: 'drop table films;',
              ...(tool === 'apply_migration' ? { name: 'drop_films' } : {}),
            },
          },
        },
        { allowInputRequired: true }
      )) as CallToolResult | InputRequiredResult;
      if (skip.includes(tool)) {
        expect(isInputRequiredResult(result)).toBe(false);
        expect((result as CallToolResult).isError).toBeFalsy();
        expect(
          (await project.db.query("select to_regclass('public.films') as name"))
            .rows
        ).toEqual([{ name: null }]);
      } else {
        expect(isInputRequiredResult(result)).toBe(true);
        expect(
          (result as InputRequiredResult).inputRequests?.confirm_destructive
        ).toMatchObject({
          method: 'elicitation/create',
          params: { mode: 'form' },
        });
        expect(
          (await project.db.query("select to_regclass('public.films') as name"))
            .rows
        ).toEqual([{ name: 'films' }]);
        await project.db.exec('drop table films');
      }
    }

    const { tools } = await client.listTools();
    for (const name of ['create_project', 'create_branch']) {
      expect(
        tools
          .find((tool) => tool.name === name)
          ?.inputSchema.required?.includes('confirm_cost_id') ?? false
      ).toBe(skip.includes(name));
    }
    for (const name of ['get_cost', 'confirm_cost']) {
      const cost = tools.find((tool) => tool.name === name);
      if (skip.includes('create_project')) {
        expect(cost?.inputSchema.properties?.type).toMatchObject({
          enum: ['project', 'branch'],
        });
      } else {
        expect(cost).toBeUndefined();
      }
    }
  });

  test.each([
    'create_project',
    'create_branch',
    ' create_project, ,create_branch ',
    'create_project,create_branch,execute_sql,apply_migration',
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

  test.each(['', 'execute_sql', 'run_notebook'])(
    'notebook run confirmation respects HTTP skip_elicitations=%j',
    async (skip) => {
      const skipped = skip === 'run_notebook';
      const { project } = await createProjectFixture();
      await project.db.exec('create table films (id int)');
      const notebook = project.createNotebook({
        name: 'HTTP execution',
        content: {
          schema_version: 1,
          cells: [
            {
              id: 'first',
              type: 'database',
              sql: 'create table notebook_probe (id int)',
              row_limit: 100,
            },
            {
              id: 'last',
              type: 'database',
              sql: 'drop table films',
              row_limit: 100,
            },
          ],
        },
      });
      const client = await connect(
        { pin: MODERN_PROTOCOL_VERSION },
        `project_ref=${project.id}&features=notebooks,database&skip_elicitations=${skip}`,
        {
          capabilities: { elicitation: { form: {} } },
          inputRequired: { autoFulfill: false },
        }
      );
      const result = (await client.request(
        {
          method: 'tools/call',
          params: {
            name: 'run_notebook',
            arguments: {
              notebook_id: notebook.id,
              expected_updated_at: notebook.attributes.updated_at,
            },
          },
        },
        { allowInputRequired: true }
      )) as CallToolResult | InputRequiredResult;
      expect(isInputRequiredResult(result)).toBe(!skipped);
      if (!isInputRequiredResult(result)) {
        expect(result.isError).toBeFalsy();
      }
      expect(
        (
          await project.db.query(
            "select to_regclass('public.notebook_probe') as name"
          )
        ).rows
      ).toEqual([{ name: skipped ? 'notebook_probe' : null }]);
      expect(
        (await project.db.query("select to_regclass('public.films') as name"))
          .rows
      ).toEqual([{ name: skipped ? null : 'films' }]);
    }
  );

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

  test.each(['unknown', 'Create_Project'])(
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
