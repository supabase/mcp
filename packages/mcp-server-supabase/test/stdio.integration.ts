import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import gqlmin from 'gqlmin';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ACCESS_TOKEN,
  contentApiMockSchema,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_SERVER_VERSION,
} from './mocks.js';

type ProtocolEra = 'legacy' | 'modern';

type SetupOptions = {
  era?: ProtocolEra;
  accessToken?: string;
  projectId?: string;
  readOnly?: boolean;
  features?: string;
  contentApiUrl?: string;
  apiUrl?: string;
  env?: Record<string, string>;
};

function assertStdioBuildIsFresh() {
  const buildPath = 'dist/cli.js';
  const newestSource = readdirSync('src', {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .reduce((newest, source) =>
      source.mtimeMs > newest.mtimeMs ? source : newest
    );
  const buildMtimeMs = existsSync(buildPath)
    ? statSync(buildPath).mtimeMs
    : Number.NEGATIVE_INFINITY;

  expect(
    buildMtimeMs,
    `${buildPath} is missing or older than ${newestSource.path}; run \`pnpm build\`.`
  ).toBeGreaterThanOrEqual(newestSource.mtimeMs);
}

assertStdioBuildIsFresh();

async function setup(options: SetupOptions = {}) {
  const {
    accessToken = ACCESS_TOKEN,
    era = 'legacy',
    projectId,
    readOnly,
    features,
    apiUrl,
    contentApiUrl,
    env,
  } = options;

  const client = new Client(
    {
      name: MCP_CLIENT_NAME,
      version: MCP_CLIENT_VERSION,
    },
    {
      capabilities: {},
      versionNegotiation:
        era === 'modern' ? { mode: { pin: '2026-07-28' } } : { mode: 'legacy' },
    }
  );

  client.setNotificationHandler('notifications/message', (message) => {
    const { level, data } = message.params;
    if (level === 'error') {
      console.error(data);
    } else {
      console.log(data);
    }
  });

  const command = 'node';
  const args = ['dist/cli.js'];

  if (accessToken) {
    args.push('--access-token', accessToken);
  }

  if (projectId) {
    args.push('--project-ref', projectId);
  }

  if (readOnly) {
    args.push('--read-only');
  }

  if (features) {
    args.push('--features', features);
  }

  if (apiUrl) {
    args.push('--api-url', apiUrl);
  }

  if (contentApiUrl) {
    args.push('--content-api-url', contentApiUrl);
  }

  const clientTransport = new StdioClientTransport({
    command,
    args,
    env: env
      ? { ...(process.env as Record<string, string>), ...env }
      : undefined,
  });

  await client.connect(clientTransport);

  return { client, clientTransport };
}

/**
 * Local HTTP stub standing in for the docs Content API, so the spawned
 * stdio process (a separate OS process, out of reach of msw) has a real
 * endpoint to hit. Answers the `{ schema }` query with the shared mock
 * schema and counts every request it receives.
 */
async function createContentApiStub() {
  const hits: URL[] = [];

  const server: Server = createServer((req, res) => {
    hits.push(new URL(req.url ?? '/', 'http://127.0.0.1'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { schema: contentApiMockSchema } }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind content API stub');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function createManagementApiStub() {
  const hits: Array<{ method: string | undefined; url: URL }> = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    hits.push({ method: req.method, url });
    res.setHeader('Content-Type', 'application/json');

    if (
      req.method === 'GET' &&
      url.pathname === '/v1/projects' &&
      url.search === ''
    ) {
      res.end(
        JSON.stringify([
          {
            id: 'abcdefghijklmnopqrst',
            ref: 'abcdefghijklmnopqrst',
            organization_id: 'tsrqponmlkjihgfedcba',
            organization_slug: 'tsrqponmlkjihgfedcba',
            name: 'Example project',
            region: 'us-east-1',
            created_at: '2024-01-02T03:04:05.000Z',
            status: 'ACTIVE_HEALTHY',
            database: {
              host: 'db.abcdefghijklmnopqrst.supabase.co',
              version: '15.1.0.147',
              postgres_engine: '15',
              release_channel: 'ga',
            },
          },
        ])
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind management API stub');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('stdio', () => {
  const stubs: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  });

  async function assertServerContract(era: ProtocolEra) {
    const managementApiStub = await createManagementApiStub();
    const contentApiStub = await createContentApiStub();
    stubs.push(managementApiStub, contentApiStub);

    const { client } = await setup({
      apiUrl: managementApiStub.url,
      contentApiUrl: contentApiStub.url,
      era,
    });

    try {
      const { tools } = await client.listTools();
      const toolResult = await client.callTool({
        name: 'list_projects',
        arguments: {},
      });

      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'apply_migration',
        'confirm_cost',
        'create_branch',
        'create_project',
        'delete_branch',
        'deploy_edge_function',
        'execute_sql',
        'generate_typescript_types',
        'get_advisors',
        'get_cost',
        'get_edge_function',
        'get_organization',
        'get_project',
        'get_project_url',
        'get_publishable_keys',
        'list_branches',
        'list_edge_functions',
        'list_extensions',
        'list_migrations',
        'list_organizations',
        'list_projects',
        'list_tables',
        'merge_branch',
        'pause_project',
        'query_logs',
        'rebase_branch',
        'reset_branch',
        'restore_project',
        'search_docs',
      ]);
      expect(client.getServerVersion()).toEqual({
        name: 'supabase',
        title: 'Supabase',
        version: MCP_SERVER_VERSION,
      });
      expect(client.getServerCapabilities()).toEqual({
        tools: {},
      });
      const expectedToolContent = [
        {
          type: 'text',
          text: JSON.stringify({
            projects: [
              {
                id: 'abcdefghijklmnopqrst',
                ref: 'abcdefghijklmnopqrst',
                organization_id: 'tsrqponmlkjihgfedcba',
                organization_slug: 'tsrqponmlkjihgfedcba',
                name: 'Example project',
                region: 'us-east-1',
                created_at: '2024-01-02T03:04:05.000Z',
                status: 'ACTIVE_HEALTHY',
                database: {
                  host: 'db.abcdefghijklmnopqrst.supabase.co',
                  version: '15.1.0.147',
                  postgres_engine: '15',
                  release_channel: 'ga',
                },
              },
            ],
          }),
        },
      ];

      const expectedMeta =
        era === 'modern'
          ? {
              _meta: {
                'io.modelcontextprotocol/serverInfo': {
                  name: 'supabase',
                  title: 'Supabase',
                  version: MCP_SERVER_VERSION,
                },
              },
            }
          : {};
      expect(Object.hasOwn(toolResult, '_meta')).toBe(era === 'modern');
      expect(toolResult).toEqual({
        ...expectedMeta,
        content: expectedToolContent,
      });
      expect(
        managementApiStub.hits.map(({ method, url }) => ({
          method,
          pathname: url.pathname,
          search: url.search,
        }))
      ).toEqual([
        {
          method: 'GET',
          pathname: '/v1/projects',
          search: '',
        },
      ]);
      expect(contentApiStub.hits.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }

  test.each<ProtocolEra>(['legacy', 'modern'])(
    'server connects and lists tools (%s)',
    assertServerContract
  );

  test('missing access token fails', async () => {
    const setupPromise = setup({ accessToken: null as any });

    // The server is unchanged here: it still exits before completing the handshake.
    // Only the message this test's own client renders changed, from v1's
    // 'MCP error -32000: Connection closed' to v2's 'Connection closed'. Held against a
    // fixed v1 client, both the pre- and post-migration builds return the v1 string.
    await expect(setupPromise).rejects.toThrow('Connection closed');
  });

  test('invalid --features fails at startup', async () => {
    const setupPromise = setup({ features: 'invalid' });

    await expect(setupPromise).rejects.toThrow('Connection closed');
  });
});

describe('stdio content-api-url', () => {
  const stubs: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  });

  test('--content-api-url routes content API traffic to the given URL', async () => {
    const stub = await createContentApiStub();
    stubs.push(stub);

    const { client } = await setup({ contentApiUrl: stub.url });

    const { tools } = await client.listTools();
    const searchDocsTool = tools.find((tool) => tool.name === 'search_docs');

    expect(stub.hits.length).toBeGreaterThan(0);

    // The schema embedded in the tool description round-trips from the
    // stub, proving the flag reached the content API client.
    expect(searchDocsTool?.description).toContain(gqlmin(contentApiMockSchema));
  });

  test('SUPABASE_CONTENT_API_URL env var is the fallback', async () => {
    const stub = await createContentApiStub();
    stubs.push(stub);

    const { client } = await setup({
      env: { SUPABASE_CONTENT_API_URL: stub.url },
    });

    await client.listTools();

    expect(stub.hits.length).toBeGreaterThan(0);
  });

  test('--content-api-url wins over SUPABASE_CONTENT_API_URL', async () => {
    const flagStub = await createContentApiStub();
    const envStub = await createContentApiStub();
    stubs.push(flagStub, envStub);

    const { client } = await setup({
      contentApiUrl: flagStub.url,
      env: { SUPABASE_CONTENT_API_URL: envStub.url },
    });

    await client.listTools();

    expect(flagStub.hits.length).toBeGreaterThan(0);
    expect(envStub.hits.length).toBe(0);
  });
});
