import {
  Client,
  StreamableHTTPClientTransport,
  type ClientCapabilities,
} from '@modelcontextprotocol/client';
import { createMcpHandler, type Server } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod/v4';

import {
  clientSupportsExtension,
  createMcpServer,
  getClientCapabilities,
  getClientExtension,
  resource,
  resources,
  resourceTemplate,
  tool,
  type McpServerOptions,
} from './server.js';
import { StreamTransport } from './stream-transport.js';

type Era = 'legacy' | 'modern';

const UI = 'io.modelcontextprotocol/ui';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connect(
  era: Era,
  options: McpServerOptions,
  clientCapabilities: ClientCapabilities = {}
) {
  const client = new Client(
    { name: 'test-client', version: '0.1.0' },
    {
      capabilities: clientCapabilities,
      versionNegotiation:
        era === 'modern' ? { mode: { pin: '2026-07-28' } } : { mode: 'legacy' },
    }
  );

  if (era === 'modern') {
    const handler = createMcpHandler(() => createMcpServer(options), {
      legacy: 'reject',
    });
    const transport = new StreamableHTTPClientTransport(
      new URL('https://mcp.test'),
      { fetch: (url, init) => handler.fetch(new Request(url, init)) }
    );
    cleanups.push(() => handler.close());
    cleanups.push(() => transport.close());
    cleanups.push(() => client.close());
    await client.connect(transport);
  } else {
    const server: Server = createMcpServer(options);
    const clientTransport = new StreamTransport();
    const serverTransport = new StreamTransport();
    clientTransport.readable.pipeTo(serverTransport.writable);
    serverTransport.readable.pipeTo(clientTransport.writable);
    // StreamTransport.close() errors its streams; existing tests skip closing.
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }
  return client;
}

const params = z.object({});
const outputSchema = z.object({});

describe('tool _meta', () => {
  const tools = {
    with_meta: tool({
      description: 'has meta',
      parameters: params,
      outputSchema,
      _meta: { ui: { resourceUri: 'ui://x/app.html' }, 'ui/resourceUri': 'a' },
      execute: async () => ({}),
    }),
    without_meta: tool({
      description: 'no meta',
      parameters: params,
      outputSchema,
      execute: async () => ({}),
    }),
  };

  test('is listed when present and the key is absent otherwise', async () => {
    const client = await connect('legacy', {
      name: 'test',
      version: '1',
      tools,
    });
    const { tools: listed } = await client.listTools();
    const withMeta = listed.find((t) => t.name === 'with_meta')!;
    const withoutMeta = listed.find((t) => t.name === 'without_meta')!;
    expect(withMeta._meta).toEqual({
      ui: { resourceUri: 'ui://x/app.html' },
      'ui/resourceUri': 'a',
    });
    expect('_meta' in withoutMeta).toBe(false);
    expect('outputSchema' in withMeta).toBe(false);
  });
});

describe('resource _meta', () => {
  const html = 'text/html;profile=mcp-app';
  const contentMeta = { ui: { csp: { connectDomains: [] } } };
  const options: McpServerOptions = {
    name: 'test',
    version: '1',
    resources: resources('ui', [
      resource('/app.html', {
        name: 'app',
        mimeType: html,
        _meta: { ui: { prefersBorder: true } },
        read: async (uri) => ({
          uri,
          mimeType: html,
          text: '<html></html>',
          _meta: contentMeta,
        }),
      }),
      resource('/plain.html', {
        name: 'plain',
        read: async (uri) => ({ uri, text: 'x' }),
      }),
      resourceTemplate('/item/{id}', {
        name: 'templated',
        _meta: { ui: { domain: 'example.test' } },
        read: async (uri) => ({ uri, text: 'x' }),
      }),
      resourceTemplate('/other/{id}', {
        name: 'templated-plain',
        read: async (uri) => ({ uri, text: 'x' }),
      }),
    ]),
  };

  test('resources/list includes _meta only when present', async () => {
    const client = await connect('legacy', options);
    const { resources: listed } = await client.listResources();
    expect(listed.find((r) => r.name === 'app')?._meta).toEqual({
      ui: { prefersBorder: true },
    });
    expect('_meta' in listed.find((r) => r.name === 'plain')!).toBe(false);
  });

  test('resources/templates/list includes _meta only when present', async () => {
    const client = await connect('legacy', options);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(
      resourceTemplates.find((r) => r.name === 'templated')?._meta
    ).toEqual({ ui: { domain: 'example.test' } });
    expect(
      '_meta' in resourceTemplates.find((r) => r.name === 'templated-plain')!
    ).toBe(false);
  });

  test('resources/read keeps _meta on content items', async () => {
    const client = await connect('legacy', options);
    const { contents } = await client.readResource({ uri: 'ui:///app.html' });
    expect(contents).toHaveLength(1);
    expect(contents[0]?._meta).toEqual(contentMeta);
    expect(contents[0]?.mimeType).toBe(html);
  });
});

describe('extensions capability', () => {
  test('is declared when the option is set', async () => {
    const extensions = { [UI]: { mimeTypes: ['text/html;profile=mcp-app'] } };
    const client = await connect('legacy', {
      name: 'test',
      version: '1',
      tools: {},
      extensions,
    });
    expect(client.getServerCapabilities()?.extensions).toEqual(extensions);
    expect(client.getServerCapabilities()?.tools).toEqual({});
  });

  test('is absent when the option is not set', async () => {
    const client = await connect('legacy', {
      name: 'test',
      version: '1',
      tools: {},
    });
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
  });
});

describe.each<Era>(['legacy', 'modern'])(
  'client capability helpers (%s)',
  (era) => {
    type Seen = {
      caps: ClientCapabilities;
      ext: Record<string, unknown> | undefined;
      supportsUi: boolean;
      supportsOther: boolean;
    };

    async function probe(clientCapabilities: ClientCapabilities) {
      let seen: Seen | undefined;
      const client = await connect(
        era,
        {
          name: 'test',
          version: '1',
          tools: {
            probe: tool({
              description: 'probe',
              parameters: params,
              outputSchema,
              execute: async (_args, ctx) => {
                seen = {
                  caps: getClientCapabilities(ctx),
                  ext: getClientExtension(ctx, UI),
                  supportsUi: clientSupportsExtension(ctx, UI),
                  supportsOther: clientSupportsExtension(ctx, 'other/ext'),
                };
                return {};
              },
            }),
          },
        },
        clientCapabilities
      );
      await client.callTool({ name: 'probe', arguments: {} });
      return seen!;
    }

    test('reports the advertised extension', async () => {
      const extensions = { [UI]: { mimeTypes: ['text/html;profile=mcp-app'] } };
      const seen = await probe({ extensions });
      expect(seen.caps.extensions).toEqual(extensions);
      expect(seen.ext).toEqual(extensions[UI]);
      expect(seen.supportsUi).toBe(true);
      expect(seen.supportsOther).toBe(false);
    });

    test('reports no extension when not advertised', async () => {
      const seen = await probe({ elicitation: { form: {} } });
      expect(seen.caps.elicitation).toBeDefined();
      expect(seen.caps.extensions).toBeUndefined();
      expect(seen.ext).toBeUndefined();
      expect(seen.supportsUi).toBe(false);
    });

    test('reports empty capabilities for a bare client', async () => {
      const seen = await probe({});
      expect(seen.supportsUi).toBe(false);
    });
  }
);
