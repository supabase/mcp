import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { CallToolRequestParams } from '@modelcontextprotocol/client';
import {
  createMcpHandler,
  type JSONRPCMessage,
  type Server,
} from '@modelcontextprotocol/server';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod/v4';

import {
  createMcpServer,
  type McpServerOptions,
  resource,
  resources,
  resourceTemplate,
  tool,
} from './server.js';
import { StreamTransport } from './stream-transport.js';

export const MCP_CLIENT_NAME = 'test-client';
export const MCP_CLIENT_VERSION = '0.1.0';

type SetupOptions = {
  server: Server;
};

/**
 * Sets up an MCP client and server for testing.
 */
async function setup(options: SetupOptions) {
  const { server } = options;
  const clientTransport = new StreamTransport();
  const serverTransport = new StreamTransport();

  clientTransport.readable.pipeTo(serverTransport.writable);
  serverTransport.readable.pipeTo(clientTransport.writable);

  const client = new Client(
    {
      name: MCP_CLIENT_NAME,
      version: MCP_CLIENT_VERSION,
    },
    {
      capabilities: {},
    }
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  /**
   * Calls a tool with the given parameters.
   *
   * Wrapper around the `client.callTool` method to handle the response and errors.
   */
  async function callTool(params: CallToolRequestParams) {
    const output = await client.callTool(params);
    const { content } = output;
    const [textContent] = content;

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

  return { client, clientTransport, callTool, server, serverTransport };
}

describe('tools', () => {
  test('parameter set to default value when omitted by caller', async () => {
    const server = createMcpServer({
      name: 'test-server',
      version: '0.0.0',
      tools: {
        search: tool({
          description: 'Search text',
          parameters: z.object({
            query: z.string(),
            caseSensitive: z.boolean().default(false),
          }),
          outputSchema: z.object({
            query: z.string(),
            caseSensitive: z.boolean(),
          }),
          execute: async (args) => {
            return args;
          },
        }),
      },
    });

    const { callTool } = await setup({ server });

    // Call the tool without the optional parameter
    const result = await callTool({
      name: 'search',
      arguments: {
        query: 'hello',
      },
    });

    expect(result).toEqual({
      query: 'hello',
      caseSensitive: false,
    });
  });

  test('tool callback is called for success and errors', async () => {
    const onToolCall = vi.fn();

    const server = createMcpServer({
      name: 'test-server',
      version: '0.0.0',
      onToolCall,
      tools: {
        good_tool: tool({
          description: 'A tool that always succeeds',
          annotations: {
            title: 'Good tool',
            readOnlyHint: true,
          },
          parameters: z.object({ foo: z.string() }),
          outputSchema: z.object({ value: z.string() }),
          execute: async ({ foo }) => {
            return { value: foo };
          },
        }),
        bad_tool: tool({
          description: 'A tool that always fails',
          annotations: {
            title: 'Bad tool',
            readOnlyHint: true,
          },
          parameters: z.object({ foo: z.string() }),
          outputSchema: z.object({ value: z.string() }),
          execute: async ({ foo }) => {
            throw new Error('Failure: ' + foo);
          },
        }),
      },
    });

    const { callTool } = await setup({ server });

    const goodToolPromise = callTool({
      name: 'good_tool',
      arguments: { foo: 'bar' },
    });

    await expect(goodToolPromise).resolves.toEqual({ value: 'bar' });
    expect(onToolCall).toHaveBeenLastCalledWith({
      name: 'good_tool',
      arguments: { foo: 'bar' },
      annotations: {
        title: 'Good tool',
        readOnlyHint: true,
      },
      success: true,
      data: { value: 'bar' },
    });

    const badToolPromise = callTool({
      name: 'bad_tool',
      arguments: { foo: 'bar' },
    });

    await expect(badToolPromise).rejects.toThrow('Failure: bar');
    expect(onToolCall).toHaveBeenLastCalledWith({
      name: 'bad_tool',
      arguments: { foo: 'bar' },
      annotations: {
        title: 'Bad tool',
        readOnlyHint: true,
      },
      success: false,
      error: expect.any(Error),
    });
  });

  test("tool callback error doesn't fail the tool call", async () => {
    const onToolCall = vi.fn(() => {
      throw new Error('Tool callback failed');
    });

    const server = createMcpServer({
      name: 'test-server',
      version: '0.0.0',
      onToolCall,
      tools: {
        good_tool: tool({
          description: 'A tool that always succeeds',
          annotations: {
            title: 'Good tool',
            readOnlyHint: true,
          },
          parameters: z.object({ foo: z.string() }),
          outputSchema: z.object({ value: z.string() }),
          execute: async ({ foo }) => {
            return { value: foo };
          },
        }),
      },
    });

    const { callTool } = await setup({ server });

    const goodToolPromise = callTool({
      name: 'good_tool',
      arguments: { foo: 'bar' },
    });

    await expect(goodToolPromise).resolves.toEqual({ value: 'bar' });
    expect(onToolCall.mock.results[0]?.type).toBe('throw');
  });

  test('hidden tool is excluded from tools/list but still callable via tools/call', async () => {
    const server = createMcpServer({
      name: 'test-server',
      version: '0.0.0',
      tools: {
        visible_tool: tool({
          description: 'A visible tool',
          parameters: z.object({ foo: z.string() }),
          outputSchema: z.object({ value: z.string() }),
          execute: async ({ foo }) => {
            return { value: foo };
          },
        }),
        hidden_tool: tool({
          description: 'A hidden tool',
          hidden: true,
          parameters: z.object({ foo: z.string() }),
          outputSchema: z.object({ value: z.string() }),
          execute: async ({ foo }) => {
            return { value: foo };
          },
        }),
      },
    });

    const { client, callTool } = await setup({ server });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(['visible_tool']);
    expect(toolNames).not.toContain('hidden_tool');

    const result = await callTool({
      name: 'hidden_tool',
      arguments: { foo: 'bar' },
    });

    expect(result).toEqual({ value: 'bar' });
  });

  test('tools use draft-07 JSON Schema', async () => {
    const server = createMcpServer({
      name: 'test-server',
      version: '0.0.0',
      tools: {
        tool: tool({
          description: 'A tool that always succeeds',
          annotations: {
            title: 'Good tool',
            readOnlyHint: true,
          },
          parameters: z.object({ foo: z.string() }),
          outputSchema: z.object({ message: z.string() }),
          execute: async ({ foo }) => {
            return { message: foo };
          },
        }),
      },
    });

    const { client } = await setup({ server });

    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.inputSchema['$schema']).toBe(
        'http://json-schema.org/draft-07/schema#'
      );
    }
  });

  test('tool result shaped like ordinary data with a content array is JSON-wrapped, not passed through raw', async () => {
    const server = createMcpServer({
      name: 'test-server',
      version: '0.0.0',
      tools: {
        report: tool({
          description:
            'Returns business data that happens to have a content field',
          parameters: z.object({}),
          outputSchema: z.object({
            title: z.string(),
            content: z.array(z.object({ label: z.string() })),
          }),
          execute: async () => {
            return {
              title: 'Report',
              content: [{ label: 'first' }, { label: 'second' }],
            };
          },
        }),
      },
    });

    const { callTool } = await setup({ server });

    const result = await callTool({
      name: 'report',
      arguments: {},
    });

    expect(result).toEqual({
      title: 'Report',
      content: [{ label: 'first' }, { label: 'second' }],
    });
  });
});

describe('tools/list cache hints', () => {
  const ttlMs = 123_000;

  function createServerOptions(options: { toolsListTtlMs?: number } = {}) {
    return {
      name: 'test-server',
      version: '0.0.0',
      ...options,
      tools: {
        noop: tool({
          description: 'Does nothing',
          parameters: z.object({}),
          outputSchema: z.object({}),
          execute: async () => ({}),
        }),
      },
    };
  }

  /** The raw `tools/list` result the server put on the wire. */
  function findToolsListResult(sent: JSONRPCMessage[]) {
    const response = sent.find(
      (message) => 'result' in message && 'tools' in (message.result ?? {})
    );
    if (!response || !('result' in response)) {
      throw new Error('tools/list response not found');
    }
    return response.result as Record<string, unknown>;
  }

  /**
   * Serves `options` the way the hosted deployment does (a fresh server per
   * request via `createMcpHandler`) to a client pinned to 2026-07-28,
   * recording every raw JSON-RPC message in the HTTP response bodies.
   */
  async function setupModern(options: McpServerOptions) {
    const handler = createMcpHandler(() => createMcpServer(options));
    const sent: JSONRPCMessage[] = [];

    const transport = new StreamableHTTPClientTransport(
      new URL('https://mcp.test'),
      {
        fetch: async (url, init) => {
          const response = await handler.fetch(new Request(url, init));
          sent.push(...(await parseBody(response.clone())));
          return response;
        },
      }
    );
    const client = new Client(
      { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      }
    );

    await client.connect(transport);

    return { client, sent };
  }

  /** Extracts the JSON-RPC messages from a JSON or SSE response body. */
  async function parseBody(response: Response): Promise<JSONRPCMessage[]> {
    const text = await response.text();
    if (!text) {
      return [];
    }
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      return text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice('data:'.length)));
    }
    const body = JSON.parse(text);
    return Array.isArray(body) ? body : [body];
  }

  /** Connects a legacy (2025-11-25) client in-memory, recording the wire. */
  async function setupLegacy(options: McpServerOptions) {
    const clientTransport = new StreamTransport();
    const serverTransport = new StreamTransport();
    const sent: JSONRPCMessage[] = [];

    clientTransport.readable.pipeTo(serverTransport.writable);
    serverTransport.readable
      .pipeThrough(
        new TransformStream<JSONRPCMessage, JSONRPCMessage>({
          transform(message, controller) {
            sent.push(message);
            controller.enqueue(message);
          },
        })
      )
      .pipeTo(clientTransport.writable);

    const client = new Client(
      { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      { capabilities: {}, versionNegotiation: { mode: 'legacy' } }
    );

    await createMcpServer(options).connect(serverTransport);
    await client.connect(clientTransport);

    return { client, sent };
  }

  test('2026-07-28 responses carry ttlMs and a private cacheScope', async () => {
    const { client, sent } = await setupModern(
      createServerOptions({ toolsListTtlMs: ttlMs })
    );

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['noop']);

    const result = findToolsListResult(sent);
    expect(result.ttlMs).toBe(ttlMs);
    expect(result.cacheScope).toBe('private');
  });

  test('2025-11-25 responses carry neither field', async () => {
    const { client, sent } = await setupLegacy(
      createServerOptions({ toolsListTtlMs: ttlMs })
    );

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['noop']);

    const result = findToolsListResult(sent);
    expect(result).not.toHaveProperty('ttlMs');
    expect(result).not.toHaveProperty('cacheScope');
  });

  test('without toolsListTtlMs the SDK default applies on 2026-07-28', async () => {
    const { client, sent } = await setupModern(createServerOptions());

    await client.listTools();

    const result = findToolsListResult(sent);
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe('private');
  });
});

describe('resources helper', () => {
  test('should add scheme to resource URIs', () => {
    const output = resources('my-scheme', [
      resource('/schemas', {
        name: 'schemas',
        description: 'Postgres schemas',
        read: async () => [],
      }),
      resourceTemplate('/schemas/{schema}', {
        name: 'schema',
        description: 'Postgres schema',
        read: async () => [],
      }),
    ]);

    const outputUris = output.map((resource) =>
      'uri' in resource ? resource.uri : resource.uriTemplate
    );

    expect(outputUris).toEqual([
      'my-scheme:///schemas',
      'my-scheme:///schemas/{schema}',
    ]);
  });

  test('should not overwrite existing scheme in resource URIs', () => {
    const output = resources('my-scheme', [
      resource('/schemas', {
        name: 'schemas',
        description: 'Postgres schemas',
        read: async () => [],
      }),
      resourceTemplate('/schemas/{schema}', {
        name: 'schema',
        description: 'Postgres schema',
        read: async () => [],
      }),
    ]);

    const outputUris = output.map((resource) =>
      'uri' in resource ? resource.uri : resource.uriTemplate
    );

    expect(outputUris).toEqual([
      'my-scheme:///schemas',
      'my-scheme:///schemas/{schema}',
    ]);
  });
});
