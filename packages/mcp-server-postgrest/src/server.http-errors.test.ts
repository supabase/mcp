import { Client } from '@modelcontextprotocol/client';
import { StreamTransport } from '@supabase/mcp-utils';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createPostgrestMcpServer } from './server.js';

type StubResponse = { status: number; contentType?: string; body: string };

let stub: Server;
let stubUrl: string;
const responses = new Map<string, StubResponse>();

beforeAll(async () => {
  stub = createServer((req, res) => {
    const stubResponse = responses.get(req.url ?? '') ?? {
      status: 404,
      body: '',
    };
    res.writeHead(stubResponse.status, {
      'content-type': stubResponse.contentType ?? 'application/json',
    });
    res.end(stubResponse.body);
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

async function setup() {
  const clientTransport = new StreamTransport();
  const serverTransport = new StreamTransport();

  clientTransport.readable.pipeTo(serverTransport.writable);
  serverTransport.readable.pipeTo(clientTransport.writable);

  const client = new Client(
    { name: 'TestClient', version: '0.1.0' },
    { capabilities: {} }
  );

  const server = createPostgrestMcpServer({
    apiUrl: stubUrl,
    schema: 'public',
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client };
}

describe('postgrestRequest HTTP errors', () => {
  test('PostgREST JSON error is reported as a tool error', async () => {
    responses.set('/todos', {
      status: 400,
      body: JSON.stringify({
        code: '42501',
        message: 'permission denied for table todos',
      }),
    });
    const { client } = await setup();

    const result = await client.callTool({
      name: 'postgrestRequest',
      arguments: { method: 'GET', path: '/todos' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('42501');
  });

  test('non-JSON error body is reported with its status', async () => {
    responses.set('/todos', {
      status: 500,
      contentType: 'text/html',
      body: '<html>Internal Server Error</html>',
    });
    const { client } = await setup();

    const result = await client.callTool({
      name: 'postgrestRequest',
      arguments: { method: 'GET', path: '/todos' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('500');
  });

  test('successful JSON response is returned unchanged', async () => {
    responses.set('/todos', {
      status: 200,
      body: JSON.stringify([{ id: 1 }]),
    });
    const { client } = await setup();

    const result = await client.callTool({
      name: 'postgrestRequest',
      arguments: { method: 'GET', path: '/todos' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ result: [{ id: 1 }] }) },
    ]);
  });

  test('empty successful response returns a null result', async () => {
    responses.set('/todos?id=eq.1', { status: 204, body: '' });
    const { client } = await setup();

    const result = await client.callTool({
      name: 'postgrestRequest',
      arguments: { method: 'DELETE', path: '/todos?id=eq.1' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ result: null }) },
    ]);
  });
});
