import { Client } from '@modelcontextprotocol/client';
import { StreamTransport } from '@supabase/mcp-utils';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createPostgrestMcpServer } from './server.js';

type StubResponse = {
  status: number;
  statusMessage?: string;
  contentType?: string;
  body: string;
};

let stub: Server;
let stubUrl: string;
const responses = new Map<string, StubResponse>();

beforeAll(async () => {
  stub = createServer((req, res) => {
    const stubResponse = responses.get(req.url ?? '') ?? {
      status: 404,
      body: '',
    };
    res.writeHead(stubResponse.status, stubResponse.statusMessage ?? '', {
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
  // Record what the server sends, since the client discards resource error
  // payloads while validating the result.
  const serverMessages: unknown[] = [];
  serverTransport.readable
    .pipeThrough(
      new TransformStream({
        transform(message, controller) {
          serverMessages.push(message);
          controller.enqueue(message);
        },
      })
    )
    .pipeTo(clientTransport.writable);

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

  return { client, serverMessages };
}

async function readSpecError(client: Client, serverMessages: unknown[]) {
  const { resources } = await client.listResources();
  const spec = resources.find((resource) => resource.name === 'OpenAPI spec');
  expect(spec).toBeDefined();
  // The client rejects the server's error payload as an invalid result, so the
  // PostgREST message is only visible in the raw server response.
  await expect(client.readResource({ uri: spec!.uri })).rejects.toThrow();
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

  test('200 response that is not JSON reports status and content type', async () => {
    responses.set('/todos', {
      status: 200,
      contentType: 'text/html',
      body: '<html>Not the API</html>',
    });
    const { client } = await setup();

    const result = await client.callTool({
      name: 'postgrestRequest',
      arguments: { method: 'GET', path: '/todos' },
    });

    expect(result.isError).toBe(true);
    const message = JSON.stringify(result.content);
    expect(message).toContain('200');
    expect(message).toContain('text/html');
  });

  test('error response with an empty body still names the status', async () => {
    responses.set('/todos', { status: 404, body: '' });
    const { client } = await setup();

    const result = await client.callTool({
      name: 'postgrestRequest',
      arguments: { method: 'GET', path: '/todos' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('PostgREST 404');
    expect(JSON.stringify(result.content)).not.toContain('PostgREST 404:');
  });
});

describe('/spec resource HTTP errors', () => {
  test('error response rejects with its status', async () => {
    responses.set('/', { status: 404, body: '' });
    const { client, serverMessages } = await setup();

    await readSpecError(client, serverMessages);

    expect(JSON.stringify(serverMessages.at(-1))).toContain('PostgREST 404');
  });

  test('200 response that is not JSON rejects with status and content type', async () => {
    responses.set('/', {
      status: 200,
      contentType: 'text/html',
      body: '<html>Not the API</html>',
    });
    const { client, serverMessages } = await setup();

    await readSpecError(client, serverMessages);

    const message = JSON.stringify(serverMessages.at(-1));
    expect(message).toContain('200');
    expect(message).toContain('text/html');
  });
});
