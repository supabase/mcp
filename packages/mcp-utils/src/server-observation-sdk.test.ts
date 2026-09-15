import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  createMcpHandler,
  createRequestStateCodec,
  type JSONRPCMessage,
  type Server,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod/v4';
import { createMcpServer, tool } from './server.js';
import { StreamTransport } from './stream-transport.js';

const MCP_CLIENT_NAME = 'test-client';
const MCP_CLIENT_VERSION = '0.1.0';
const clients: Client[] = [];
const pipes: Promise<PromiseSettledResult<void>[]>[] = [];

afterEach(async () => {
  try {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    for (const pending of pipes.splice(0)) {
      await pending;
    }
  } finally {
    vi.restoreAllMocks();
  }
});

async function setup(options: { server: Server }) {
  const { server } = options;
  const clientTransport = new StreamTransport();
  const serverTransport = new StreamTransport();

  pipes.push(
    Promise.allSettled([
      clientTransport.readable.pipeTo(serverTransport.writable),
      serverTransport.readable.pipeTo(clientTransport.writable),
    ])
  );

  const client = new Client(
    {
      name: MCP_CLIENT_NAME,
      version: MCP_CLIENT_VERSION,
    },
    {
      capabilities: {},
    }
  );

  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, clientTransport };
}

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
      clients.push(client);
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
