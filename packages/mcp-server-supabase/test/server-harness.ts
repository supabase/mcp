import {
  Client,
  type CallToolRequestParams,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { Server } from '@modelcontextprotocol/server';
import { StreamTransport } from '@supabase/mcp-utils';
import type { SetupServer } from 'msw/node';
import { createSupabaseApiPlatform } from '../src/platform/api-platform.js';
import type { SupabasePlatform } from '../src/platform/types.js';
import {
  createSupabaseMcpServer,
  type SupabaseMcpServerOptions,
} from '../src/server.js';
import type { supabaseMcpToolSchemas } from '../src/tools/tool-schemas.js';
import { createSupabaseMcpHandler } from '../src/transports/http.js';
import {
  ACCESS_TOKEN,
  API_URL,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  mockProjects,
  setupMockApis,
} from './mocks.js';

type SetupOptions = {
  accessToken?: string;
  projectId?: string;
  platform?: SupabasePlatform;
  readOnly?: boolean;
  features?: string[];
  elicitation?: SupabaseMcpServerOptions['elicitation'];
  observer?: SupabaseMcpServerOptions['observer'];
  onToolCall?: SupabaseMcpServerOptions['onToolCall'];
  clientCapabilities?: ClientCapabilities;
};

type ModernSetupOptions = {
  platform?: SupabasePlatform;
  features?: string[];
  observer?: SupabaseMcpServerOptions['observer'];
  onToolCall?: SupabaseMcpServerOptions['onToolCall'];
  elicitation?: SupabaseMcpServerOptions['elicitation'];
  clientCapabilities?: ClientCapabilities;
  readOnly?: boolean;
  projectId?: string;
  secretCollection?: NonNullable<
    NonNullable<SupabaseMcpServerOptions['elicitation']>['secretCollection']
  >;
  elicitationAction?: 'accept' | 'decline' | 'cancel';
};

export function callModernTool(
  client: Client,
  params: CallToolRequestParams & {
    inputResponses?: Record<string, unknown>;
    requestState?: string;
  }
): Promise<CallToolResult | InputRequiredResult> {
  return client.request(
    { method: 'tools/call', params },
    { allowInputRequired: true }
  ) as Promise<CallToolResult | InputRequiredResult>;
}

type ToolCall = Omit<CallToolRequestParams, 'name'> & {
  name: keyof typeof supabaseMcpToolSchemas;
};

type Connection = {
  shutdown: AbortController;
  pipes: Promise<void>[];
  clientTransport?: StreamTransport;
  serverTransport?: StreamTransport;
  client?: Client;
  server?: Server;
};

/** Suite-local ownership; callers explicitly opt into reset/close hooks. */
export function createServerHarness() {
  let mockServer: SetupServer | undefined;
  const connections: Connection[] = [];
  const modernCleanups: Array<() => Promise<void>> = [];
  const pipeErrors: unknown[] = [];
  const shutdownReason = new Error('Test harness stream shutdown');

  function reset() {
    if (mockServer || connections.length || modernCleanups.length) {
      throw new Error('Close the server harness before resetting it');
    }
    mockServer = setupMockApis();
  }

  async function setup(options: SetupOptions = {}) {
    const {
      accessToken = ACCESS_TOKEN,
      projectId,
      readOnly,
      features,
      elicitation,
      clientCapabilities = {},
    } = options;
    const connection: Connection = {
      shutdown: new AbortController(),
      pipes: [],
    };
    // Retain partial resources even when construction or connect throws.
    connections.push(connection);
    const clientTransport = (connection.clientTransport =
      new StreamTransport());
    const serverTransport = (connection.serverTransport =
      new StreamTransport());
    const pipeOptions = {
      signal: connection.shutdown.signal,
      preventAbort: true,
      preventCancel: true,
    };
    for (const [source, destination] of [
      [clientTransport, serverTransport],
      [serverTransport, clientTransport],
    ] as const) {
      connection.pipes.push(
        source.readable
          .pipeTo(destination.writable, pipeOptions)
          .catch((error) => {
            // Identity, not error text or a broad closing flag, proves local shutdown.
            if (error !== shutdownReason) {
              pipeErrors.push(error);
            }
          })
      );
    }

    const client = (connection.client = new Client(
      { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      { capabilities: clientCapabilities }
    ));
    const platform =
      options.platform ??
      createSupabaseApiPlatform({ accessToken, apiUrl: API_URL });
    const server = (connection.server = createSupabaseMcpServer({
      platform,
      projectId,
      readOnly,
      features,
      elicitation,
      observer: options.observer,
      onToolCall: options.onToolCall,
    }));

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    async function callTool(params: ToolCall) {
      const output = await client.callTool(params);
      const [textContent] = output.content;
      if (!textContent) {
        return undefined;
      }
      if (textContent.type !== 'text') {
        throw new Error('tool result content is not text');
      }
      if (textContent.text === '') {
        throw new Error('tool result content is empty');
      }
      const result = JSON.parse(textContent.text);
      if (output.isError) {
        throw new Error(result.error.message);
      }
      return result;
    }

    return { client, callTool };
  }

  async function setupModern(options: ModernSetupOptions = {}) {
    const {
      elicitation = {
        requestState: { key: 'a'.repeat(32), principal: 'test-user' },
        confirmation: {
          enabledTools: [
            'create_project',
            'create_branch',
            'execute_sql',
            'apply_migration',
          ],
        },
      },
      clientCapabilities = {},
      secretCollection,
      elicitationAction,
      readOnly,
      projectId,
    } = options;
    const platform =
      options.platform ??
      createSupabaseApiPlatform({
        accessToken: ACCESS_TOKEN,
        apiUrl: API_URL,
      });
    // Modern requests do not perform an initialize handshake. Keep the
    // management API User-Agent initialization separate from client capabilities.
    await platform.init?.({
      clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      clientCapabilities: { elicitation: { form: {} } },
    });

    const handler = createSupabaseMcpHandler({
      platform,
      projectId,
      readOnly,
      features: options.features,
      observer: options.observer,
      onToolCall: options.onToolCall,
      elicitation: secretCollection
        ? { ...elicitation, secretCollection }
        : elicitation,
    });
    modernCleanups.push(() => handler.close());
    const transport = new StreamableHTTPClientTransport(
      new URL('https://mcp.test'),
      { fetch: (url, init) => handler.fetch(new Request(url, init)) }
    );
    modernCleanups.push(() => transport.close());
    const client = new Client(
      { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      {
        capabilities: clientCapabilities,
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        ...(elicitationAction === undefined && {
          inputRequired: { autoFulfill: false },
        }),
      }
    );
    modernCleanups.push(() => client.close());
    if (elicitationAction !== undefined) {
      client.setRequestHandler('elicitation/create', async () =>
        elicitationAction === 'accept'
          ? { action: 'accept' as const, content: {} }
          : { action: elicitationAction }
      );
    }
    await client.connect(transport);
    return { client, platform };
  }

  async function close() {
    const errors: unknown[] = [];
    try {
      for (const cleanup of modernCleanups.splice(0).reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      const ownedConnections = connections.splice(0);
      // Detach pipes before StreamTransport.close errors its controllers. Only
      // these aborts use our private reason; other pipe failures remain visible.
      for (const connection of ownedConnections) {
        connection.shutdown.abort(shutdownReason);
      }
      for (const connection of ownedConnections) {
        await Promise.all(connection.pipes);
        for (const resource of [
          connection.client,
          connection.server,
          connection.clientTransport,
          connection.serverTransport,
        ]) {
          try {
            await resource?.close();
          } catch (error) {
            errors.push(error);
          }
        }
      }
      errors.push(...pipeErrors.splice(0));
      // Map clearing is reset, not disposal. destroy never opens a lazy DB.
      for (const project of mockProjects.values()) {
        try {
          await project.destroy();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      try {
        mockServer?.close();
      } catch (error) {
        errors.push(error);
      } finally {
        mockServer = undefined;
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, 'Server harness teardown failed');
    }
  }

  return {
    setup,
    setupModern,
    reset,
    close,
    get mockServer() {
      return mockServer;
    },
  };
}
