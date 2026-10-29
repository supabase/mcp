import { Client } from '@modelcontextprotocol/client';
import { StreamTransport } from '@supabase/mcp-utils';
import { describe, expect, test } from 'vitest';

import {
  ACCESS_TOKEN,
  API_URL,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
} from '../test/mocks.js';
import {
  createSupabaseMcpServer,
  isToolCallerError,
  ToolCallerError,
  version,
} from './index.js';
import { createSupabaseApiPlatform } from './platform/api-platform.js';

type SetupOptions = {
  accessToken?: string;
  projectId?: string;
  readOnly?: boolean;
  features?: string[];
};

async function setup(options: SetupOptions = {}) {
  const { accessToken = ACCESS_TOKEN, projectId, readOnly, features } = options;
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

  const platform = createSupabaseApiPlatform({
    apiUrl: API_URL,
    accessToken,
  });

  const server = createSupabaseMcpServer({
    platform,
    projectId,
    readOnly,
    features,
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, clientTransport, server, serverTransport };
}

describe('index', () => {
  test('index.ts exports a working server', async () => {
    const { client } = await setup();

    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);
  });

  test('index.ts exports a version', () => {
    expect(version).toStrictEqual(expect.any(String));
  });

  test('isToolCallerError matches ToolCallerError instances', () => {
    const error = new ToolCallerError('bad input');

    expect(error).toMatchObject({
      name: 'ToolCallerError',
      message: 'bad input',
    });
    expect(isToolCallerError(error)).toBe(true);
  });

  test('isToolCallerError matches the brand from another package copy', () => {
    const foreign = Object.assign(new Error('bad input'), {
      [Symbol.for('supabase.mcp.callerError')]: true,
    });

    expect(foreign instanceof ToolCallerError).toBe(false);
    expect(isToolCallerError(foreign)).toBe(true);
  });

  test('isToolCallerError rejects plain errors and non-errors', () => {
    expect(isToolCallerError(new Error('boom'))).toBe(false);
    expect(isToolCallerError(null)).toBe(false);
    expect(isToolCallerError('ToolCallerError')).toBe(false);
  });
});
