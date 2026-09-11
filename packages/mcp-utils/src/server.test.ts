import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { CallToolRequestParams } from '@modelcontextprotocol/client';
import {
  createMcpHandler,
  createRequestStateCodec,
  type JSONRPCMessage,
  type Server,
} from '@modelcontextprotocol/server';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod/v4';

import {
  createMcpServer,
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

describe('observer SDK boundary', () => {
  test('initialization, notifications, malformed calls and unknown methods do not enter a scope', async () => {
    const observer = vi.fn(() => ({ record() {}, end() {} }));
    const execute = vi.fn(async () => ({}));
    const server = createMcpServer({
      name: 'test',
      version: '1',
      observer,
      tools: {
        test: tool({
          description: 'test',
          parameters: z.object({}),
          outputSchema: z.object({}),
          execute,
        }),
      },
    });
    const { clientTransport, client } = await setup({ server });
    expect(observer).not.toHaveBeenCalled();

    let id = 900;
    for (const request of [
      { method: 'tools/call', params: { name: 42 } },
      { method: 'private/unknown', params: {} },
    ]) {
      const requestId = id++;
      const previous = clientTransport.onmessage;
      // Bypass the client's outbound validator to reach real SDK prevalidation.
      // Node 20 has no Promise.withResolvers.
      const response = new Promise<JSONRPCMessage>((resolve) => {
        clientTransport.onmessage = (message) => {
          if ('id' in message && message.id === requestId) resolve(message);
          else previous?.(message);
        };
      });
      await clientTransport.send({ jsonrpc: '2.0', id: requestId, ...request });
      expect(await response).toMatchObject({
        error: { code: request.method === 'tools/call' ? -32602 : -32601 },
      });
      clientTransport.onmessage = previous;
    }
    expect(observer).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await client.callTool({ name: 'test' });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith({
      method: 'tools/call',
      tool: 'other',
    });
  });

  test.each(['signature', 'expired'] as const)(
    '%s rejection has no producer scope on the modern SDK wire',
    async (mode) => {
      // Public synthetic test key, never an application credential.
      const codec = createRequestStateCodec({
        key: 'observer-test-key'.repeat(3),
        ttlSeconds: mode === 'expired' ? -1 : 600,
      });
      const state = await codec.mint({ fixture: true });
      const dot = state.lastIndexOf('.');
      const macFirst = state[dot + 1];
      const rejectedState =
        mode === 'expired'
          ? state
          : state.slice(0, dot + 1) +
            (macFirst === 'a' ? 'b' : 'a') +
            state.slice(dot + 2);
      const observer = vi.fn(() => ({ record() {}, end() {} }));
      const execute = vi.fn(async () => ({}));
      const handler = createMcpHandler(() =>
        createMcpServer({
          name: 'test',
          version: '1',
          observer,
          requestState: { verify: codec.verify },
          tools: {
            test: tool({
              description: 'test',
              parameters: z.object({}),
              outputSchema: z.object({}),
              execute,
            }),
          },
        })
      );
      const client = new Client(
        { name: 'test', version: '1' },
        {
          versionNegotiation: { mode: { pin: '2026-07-28' } },
          inputRequired: { autoFulfill: false },
        }
      );
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL('http://observer.invalid/mcp'),
          {
            fetch: (url, init) => handler.fetch(new Request(url, init)),
          }
        )
      );
      await expect(
        client.request(
          {
            method: 'tools/call',
            params: {
              name: 'test',
              requestState: rejectedState,
              inputResponses: { confirm: { action: 'accept', content: {} } },
            },
          },
          { allowInputRequired: true }
        )
      ).rejects.toMatchObject({ code: -32602 });
      expect(observer).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      await client.request({ method: 'tools/call', params: { name: 'test' } });
      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith({
        method: 'tools/call',
        tool: 'other',
      });
    }
  );
});
