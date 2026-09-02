import { Client } from '@modelcontextprotocol/client';
import type { CallToolRequestParams } from '@modelcontextprotocol/client';
import { StreamTransport } from '@supabase/mcp-utils';
import { codeBlock, stripIndent } from 'common-tags';
import gqlmin from 'gqlmin';
import { http, HttpResponse } from 'msw';
import type { SetupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { globalRegistry } from 'zod/v4';

import {
  ACCESS_TOKEN,
  API_URL,
  contentApiMockSchema,
  createBranch,
  createOrganization,
  createProject,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  mockContentApiSchemaLoadCount,
  setupMockApis,
} from '../test/mocks.js';
import { createSupabaseApiPlatform } from './platform/api-platform.js';
import type { SupabasePlatform } from './platform/types.js';
import { BRANCH_COST_HOURLY, PROJECT_COST_MONTHLY } from './pricing.js';
import { createSupabaseMcpServer, instructions } from './server.js';
import {
  createToolSchemas,
  supabaseMcpToolSchemas,
} from './tools/tool-schemas.js';

let mockServer: SetupServer | undefined;

beforeEach(() => {
  mockServer = setupMockApis();
});

afterEach(() => {
  mockServer?.close();
});

type SetupOptions = {
  accessToken?: string;
  projectId?: string;
  platform?: SupabasePlatform;
  readOnly?: boolean;
  features?: string[];
};

/**
 * Sets up an MCP client and server for testing.
 */
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

  const platform =
    options.platform ??
    createSupabaseApiPlatform({
      accessToken,
      apiUrl: API_URL,
    });

  const server = createSupabaseMcpServer({
    platform,
    projectId,
    readOnly,
    features,
  });

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

describe('init', () => {
  test('server returns instructions', async () => {
    const { client } = await setup();
    expect(client.getInstructions()).toBe(instructions);
  });
});

describe('tools', () => {
  test('list organizations', async () => {
    const { callTool } = await setup();

    const org1 = await createOrganization({
      name: 'Org 1',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });
    const org2 = await createOrganization({
      name: 'Org 2',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const result = await callTool({
      name: 'list_organizations',
      arguments: {},
    });

    expect(result).toEqual({
      organizations: [
        { id: org1.id, slug: org1.slug, name: org1.name },
        { id: org2.id, slug: org2.slug, name: org2.name },
      ],
    });
  });

  test('get organization', async () => {
    const { callTool } = await setup();

    const org = await createOrganization({
      name: 'My Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const result = await callTool({
      name: 'get_organization',
      arguments: {
        id: org.id,
      },
    });

    expect(result).toEqual(org);
  });

  test('get next project cost for free org', async () => {
    const { callTool } = await setup();

    const freeOrg = await createOrganization({
      name: 'Free Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const result = await callTool({
      name: 'get_cost',
      arguments: {
        type: 'project',
        organization_id: freeOrg.id,
      },
    });

    expect(result).toEqual({
      type: 'project',
      amount: 0,
      recurrence: 'monthly',
    });
  });

  test('get next project cost for paid org with 0 projects', async () => {
    const { callTool } = await setup();

    const paidOrg = await createOrganization({
      name: 'Paid Org',
      plan: 'pro',
      allowed_release_channels: ['ga'],
    });

    const result = await callTool({
      name: 'get_cost',
      arguments: {
        type: 'project',
        organization_id: paidOrg.id,
      },
    });

    expect(result).toEqual({
      type: 'project',
      amount: 0,
      recurrence: 'monthly',
    });
  });

  test('get next project cost for paid org with > 0 active projects', async () => {
    const { callTool } = await setup();

    const paidOrg = await createOrganization({
      name: 'Paid Org',
      plan: 'pro',
      allowed_release_channels: ['ga'],
    });

    const priorProject = await createProject({
      name: 'Project 1',
      region: 'us-east-1',
      organization_id: paidOrg.id,
    });
    priorProject.status = 'ACTIVE_HEALTHY';

    const result = await callTool({
      name: 'get_cost',
      arguments: {
        type: 'project',
        organization_id: paidOrg.id,
      },
    });

    expect(result).toEqual({
      type: 'project',
      amount: PROJECT_COST_MONTHLY,
      recurrence: 'monthly',
    });
  });

  test('get next project cost for paid org with > 0 inactive projects', async () => {
    const { callTool } = await setup();

    const paidOrg = await createOrganization({
      name: 'Paid Org',
      plan: 'pro',
      allowed_release_channels: ['ga'],
    });

    const priorProject = await createProject({
      name: 'Project 1',
      region: 'us-east-1',
      organization_id: paidOrg.id,
    });
    priorProject.status = 'INACTIVE';

    const result = await callTool({
      name: 'get_cost',
      arguments: {
        type: 'project',
        organization_id: paidOrg.id,
      },
    });

    expect(result).toEqual({
      type: 'project',
      amount: 0,
      recurrence: 'monthly',
    });
  });

  test('get branch cost', async () => {
    const { callTool } = await setup();

    const paidOrg = await createOrganization({
      name: 'Paid Org',
      plan: 'pro',
      allowed_release_channels: ['ga'],
    });

    const result = await callTool({
      name: 'get_cost',
      arguments: {
        type: 'branch',
        organization_id: paidOrg.id,
      },
    });

    expect(result).toEqual({
      type: 'branch',
      amount: BRANCH_COST_HOURLY,
      recurrence: 'hourly',
    });
  });

  test('list projects', async () => {
    const { callTool } = await setup();

    const org = await createOrganization({
      name: 'My Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const project1 = await createProject({
      name: 'Project 1',
      region: 'us-east-1',
      organization_id: org.id,
    });

    const project2 = await createProject({
      name: 'Project 2',
      region: 'us-east-1',
      organization_id: org.id,
    });

    const result = await callTool({
      name: 'list_projects',
      arguments: {},
    });

    expect(result).toEqual({ projects: [project1.details, project2.details] });
  });

  test('get project', async () => {
    const { callTool } = await setup();

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

    const result = await callTool({
      name: 'get_project',
      arguments: {
        id: project.id,
      },
    });

    expect(result).toEqual(project.details);
  });

  test('create project', async () => {
    const { callTool } = await setup();

    const freeOrg = await createOrganization({
      name: 'Free Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const confirm_cost_id_result = await callTool({
      name: 'confirm_cost',
      arguments: {
        type: 'project',
        recurrence: 'monthly',
        amount: 0,
      },
    });

    const newProject = {
      name: 'New Project',
      region: 'us-east-1',
      organization_id: freeOrg.id,
      confirm_cost_id: confirm_cost_id_result.confirmation_id,
    };

    const result = await callTool({
      name: 'create_project',
      arguments: newProject,
    });

    expect(result).toEqual({
      id: expect.stringMatching(/^.+$/),
      ref: expect.stringMatching(/^.+$/),
      name: newProject.name,
      region: newProject.region,
      organization_id: newProject.organization_id,
      organization_slug: newProject.organization_id,
      created_at: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
      ),
      status: 'UNKNOWN',
    });
  });

  test('create project in read-only mode throws an error', async () => {
    const { callTool } = await setup({ readOnly: true });

    const freeOrg = await createOrganization({
      name: 'Free Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const confirm_cost_id_result = await callTool({
      name: 'confirm_cost',
      arguments: {
        type: 'project',
        recurrence: 'monthly',
        amount: 0,
      },
    });

    const newProject = {
      name: 'New Project',
      region: 'us-east-1',
      organization_id: freeOrg.id,
      confirm_cost_id: confirm_cost_id_result.confirmation_id,
    };

    const result = callTool({
      name: 'create_project',
      arguments: newProject,
    });

    await expect(result).rejects.toThrow(
      'Cannot create a project in read-only mode.'
    );
  });

  test('create project without region fails', async () => {
    const { callTool } = await setup();

    const freeOrg = await createOrganization({
      name: 'Free Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const confirm_cost_id_result = await callTool({
      name: 'confirm_cost',
      arguments: {
        type: 'project',
        recurrence: 'monthly',
        amount: 0,
      },
    });

    const newProject = {
      name: 'New Project',
      organization_id: freeOrg.id,
      confirm_cost_id: confirm_cost_id_result.confirmation_id,
    };

    const createProjectPromise = callTool({
      name: 'create_project',
      arguments: newProject,
    });

    await expect(createProjectPromise).rejects.toThrow();
  });

  test('create project without cost confirmation fails', async () => {
    const { callTool } = await setup();

    const org = await createOrganization({
      name: 'Paid Org',
      plan: 'pro',
      allowed_release_channels: ['ga'],
    });

    const newProject = {
      name: 'New Project',
      region: 'us-east-1',
      organization_id: org.id,
    };

    const createProjectPromise = callTool({
      name: 'create_project',
      arguments: newProject,
    });

    await expect(createProjectPromise).rejects.toThrow(
      'User must confirm understanding of costs before creating a project.'
    );
  });

  test('pause project', async () => {
    const { callTool } = await setup();

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

    await callTool({
      name: 'pause_project',
      arguments: {
        project_id: project.id,
      },
    });

    expect(project.status).toEqual('INACTIVE');
  });

  test('pause project in read-only mode throws an error', async () => {
    const { callTool } = await setup({ readOnly: true });

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

    const result = callTool({
      name: 'pause_project',
      arguments: {
        project_id: project.id,
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot pause a project in read-only mode.'
    );
  });

  test('restore project', async () => {
    const { callTool } = await setup();

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
    project.status = 'INACTIVE';

    await callTool({
      name: 'restore_project',
      arguments: {
        project_id: project.id,
      },
    });

    expect(project.status).toEqual('ACTIVE_HEALTHY');
  });

  test('restore project in read-only mode throws an error', async () => {
    const { callTool } = await setup({ readOnly: true });

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
    project.status = 'INACTIVE';

    const result = callTool({
      name: 'restore_project',
      arguments: {
        project_id: project.id,
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot restore a project in read-only mode.'
    );
  });

  test('get project url', async () => {
    const { callTool } = await setup();

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

    const result = await callTool({
      name: 'get_project_url',
      arguments: {
        project_id: project.id,
      },
    });
    expect(result).toEqual({ url: `https://${project.id}.supabase.co` });
  });

  test('get anon or publishable keys', async () => {
    const { callTool } = await setup();
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

    const result = await callTool({
      name: 'get_publishable_keys',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result.keys).toBeInstanceOf(Array);
    expect(result.keys.length).toBe(2);

    // Check legacy anon key
    const anonKey = result.keys.find((key: any) => key.name === 'anon');
    expect(anonKey).toBeDefined();
    expect(anonKey.api_key).toEqual('dummy-anon-key');
    expect(anonKey.type).toEqual('legacy');
    expect(anonKey.id).toEqual('anon-key-id');
    expect(anonKey.disabled).toBe(true);

    // Check publishable key
    const publishableKey = result.keys.find(
      (key: any) => key.type === 'publishable'
    );
    expect(publishableKey).toBeDefined();
    expect(publishableKey.api_key).toEqual('sb_publishable_dummy_key_1');
    expect(publishableKey.type).toEqual('publishable');
    expect(publishableKey.description).toEqual('Main publishable key');
  });

  test('list storage buckets', async () => {
    const { callTool } = await setup({ features: ['storage'] });

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

    project.createStorageBucket('bucket1', true);
    project.createStorageBucket('bucket2', false);

    const result = await callTool({
      name: 'list_storage_buckets',
      arguments: {
        project_id: project.id,
      },
    });

    expect(Array.isArray(result.buckets)).toBe(true);
    expect(result.buckets.length).toBe(2);
    expect(result.buckets[0]).toEqual(
      expect.objectContaining({
        name: 'bucket1',
        public: true,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
    expect(result.buckets[1]).toEqual(
      expect.objectContaining({
        name: 'bucket2',
        public: false,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
  });

  test('get storage config', async () => {
    const { callTool } = await setup({ features: ['storage'] });

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

    const result = await callTool({
      name: 'get_storage_config',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result).toEqual({
      fileSizeLimit: expect.any(Number),
      features: {
        imageTransformation: { enabled: expect.any(Boolean) },
        s3Protocol: { enabled: expect.any(Boolean) },
      },
    });
  });

  test('update storage config', async () => {
    const { callTool } = await setup({ features: ['storage'] });

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

    const config = {
      fileSizeLimit: 50,
      features: {
        imageTransformation: { enabled: true },
        s3Protocol: { enabled: false },
      },
    };

    const result = await callTool({
      name: 'update_storage_config',
      arguments: {
        project_id: project.id,
        config,
      },
    });

    expect(result).toEqual({ success: true });
  });

  test('update storage config in read-only mode throws an error', async () => {
    const { callTool } = await setup({ readOnly: true, features: ['storage'] });

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

    const config = {
      fileSizeLimit: 50,
      features: {
        imageTransformation: { enabled: true },
        s3Protocol: { enabled: false },
      },
    };

    const result = callTool({
      name: 'update_storage_config',
      arguments: {
        project_id: project.id,
        config,
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot update storage config in read-only mode.'
    );
  });

  test('execute sql', async () => {
    const { callTool } = await setup();

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

    const query = 'select 1+1 as sum';

    const result = await callTool({
      name: 'execute_sql',
      arguments: {
        project_id: project.id,
        query,
      },
    });

    expect(result.result).toContain('untrusted user data');
    expect(result.result).toMatch(
      /<untrusted-data-\w{8}-\w{4}-\w{4}-\w{4}-\w{12}>/
    );
    expect(result.result).toContain(JSON.stringify([{ sum: 2 }]));
    expect(result.result).toMatch(
      /<\/untrusted-data-\w{8}-\w{4}-\w{4}-\w{4}-\w{12}>/
    );
  });

  test('can run read queries in read-only mode', async () => {
    const { callTool } = await setup({ readOnly: true });

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

    const query = 'select 1+1 as sum';

    const result = await callTool({
      name: 'execute_sql',
      arguments: {
        project_id: project.id,
        query,
      },
    });

    expect(result.result).toContain('untrusted user data');
    expect(result.result).toMatch(
      /<untrusted-data-\w{8}-\w{4}-\w{4}-\w{4}-\w{12}>/
    );
    expect(result.result).toContain(JSON.stringify([{ sum: 2 }]));
    expect(result.result).toMatch(
      /<\/untrusted-data-\w{8}-\w{4}-\w{4}-\w{4}-\w{12}>/
    );
  });

  test('cannot run write queries in read-only mode', async () => {
    const { callTool } = await setup({ readOnly: true });

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

    const query =
      'create table test (id integer generated always as identity primary key)';

    const resultPromise = callTool({
      name: 'execute_sql',
      arguments: {
        project_id: project.id,
        query,
      },
    });

    await expect(resultPromise).rejects.toThrow(
      'permission denied for schema public'
    );
  });

  test('apply migration, list migrations, check tables', async () => {
    const { callTool } = await setup();

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

    const name = 'test_migration';
    const query =
      'create table test (id integer generated always as identity primary key)';

    const result = await callTool({
      name: 'apply_migration',
      arguments: {
        project_id: project.id,
        name,
        query,
      },
    });

    expect(result).toEqual({ success: true });

    const listMigrationsResult = await callTool({
      name: 'list_migrations',
      arguments: {
        project_id: project.id,
      },
    });

    expect(listMigrationsResult.migrations).toEqual([
      {
        name,
        version: expect.stringMatching(/^\d{14}$/),
      },
    ]);

    const listTablesResult = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    expect(listTablesResult.tables).toEqual([
      {
        name: 'public.test',
        rls_enabled: false,
        rows: 0,
        columns: [
          {
            name: 'id',
            data_type: 'integer',
            format: 'int4',
            options: ['identity', 'updatable'],
            identity_generation: 'ALWAYS',
          },
        ],
        primary_keys: ['id'],
      },
    ]);
    expect(listTablesResult.advisory).toEqual(
      expect.objectContaining({ id: 'rls_disabled' })
    );
  });

  test('list_tables returns compact summary by default', async () => {
    const { callTool } = await setup();

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

    await project.db.exec(
      'create table test (id integer generated always as identity primary key)'
    );

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
      },
    });

    expect(result).toEqual({
      tables: [
        {
          name: 'public.test',
          rls_enabled: false,
          rows: 0,
        },
      ],
      advisory: {
        id: 'rls_disabled',
        priority: 1,
        level: 'critical',
        title: 'Row Level Security is disabled',
        message: expect.stringContaining('public.test'),
        remediation_sql: 'ALTER TABLE public.test ENABLE ROW LEVEL SECURITY;',
        doc_url: expect.stringContaining('row-level-security'),
      },
    });
  });

  test('list_tables returns full details when verbose is true', async () => {
    const { callTool } = await setup();

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

    await project.db.exec(`
      create table users (id integer generated always as identity primary key);
      create table orders (
        id integer generated always as identity primary key,
        user_id integer references users(id)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    // Verbose mode should include columns, primary_keys, and foreign_key_constraints
    const ordersTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.orders'
    );
    expect(ordersTable).toEqual(
      expect.objectContaining({
        columns: expect.arrayContaining([
          expect.objectContaining({ name: 'id' }),
          expect.objectContaining({ name: 'user_id' }),
        ]),
        primary_keys: ['id'],
        foreign_key_constraints: [
          expect.objectContaining({
            source_table: 'public.orders',
            source_columns: ['user_id'],
            target_table: 'public.users',
            target_columns: ['id'],
          }),
        ],
      })
    );
  });

  test('composite FK is grouped as one constraint with positionally ordered columns', async () => {
    const { callTool } = await setup();

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

    await project.db.exec(`
      create table parent (
        y int,
        x int,
        primary key (y, x)
      );
      create table child (
        b int,
        a int,
        constraint child_parent_fk
          foreign key (b, a) references parent (y, x)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const childTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.child'
    );

    // exactly one constraint row - not one per column pair
    expect(childTable.foreign_key_constraints).toHaveLength(1);
    expect(childTable.foreign_key_constraints[0]).toEqual(
      expect.objectContaining({
        name: 'child_parent_fk',
        source_table: 'public.child',
        source_columns: ['b', 'a'],
        target_table: 'public.parent',
        target_columns: ['y', 'x'],
      })
    );
  });

  test('single-column FK is represented with one-element arrays', async () => {
    const { callTool } = await setup();

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

    await project.db.exec(`
      create table parent (
        id int primary key
      );
      create table child (
        parent_id int,
        constraint child_parent_fk
          foreign key (parent_id) references parent (id)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const childTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.child'
    );

    expect(childTable.foreign_key_constraints).toHaveLength(1);
    expect(childTable.foreign_key_constraints[0]).toEqual(
      expect.objectContaining({
        name: 'child_parent_fk',
        source_table: 'public.child',
        source_columns: ['parent_id'],
        target_table: 'public.parent',
        target_columns: ['id'],
      })
    );
  });

  test('self-referential composite FK is reported once with correct pairing', async () => {
    const { callTool } = await setup();

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

    await project.db.exec(`
      create table node (
        a int,
        b int,
        parent_a int,
        parent_b int,
        primary key (a, b),
        constraint node_parent_fk
          foreign key (parent_a, parent_b) references node (a, b)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const nodeTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.node'
    );

    const selfFk = nodeTable.foreign_key_constraints.filter(
      (fk: { name: string }) => fk.name === 'node_parent_fk'
    );
    expect(selfFk).toHaveLength(1);
    expect(selfFk[0]).toEqual(
      expect.objectContaining({
        source_table: 'public.node',
        source_columns: ['parent_a', 'parent_b'],
        target_table: 'public.node',
        target_columns: ['a', 'b'],
      })
    );
  });

  test('two independent composite FKs between the same tables stay separate', async () => {
    const { callTool } = await setup();

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

    await project.db.exec(`
      create table parent (
        x int,
        y int,
        primary key (x, y)
      );
      create table child (
        a1 int,
        a2 int,
        b1 int,
        b2 int,
        constraint child_fk_a
          foreign key (a1, a2) references parent (x, y),
        constraint child_fk_b
          foreign key (b1, b2) references parent (x, y)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const childTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.child'
    );

    const fkA = childTable.foreign_key_constraints.find(
      (fk: { name: string }) => fk.name === 'child_fk_a'
    );
    const fkB = childTable.foreign_key_constraints.find(
      (fk: { name: string }) => fk.name === 'child_fk_b'
    );
    expect(fkA).toEqual(
      expect.objectContaining({
        source_columns: ['a1', 'a2'],
        target_columns: ['x', 'y'],
      })
    );
    expect(fkB).toEqual(
      expect.objectContaining({
        source_columns: ['b1', 'b2'],
        target_columns: ['x', 'y'],
      })
    );
  });

  test('three-column composite FK preserves column order', async () => {
    const { callTool } = await setup();

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

    await project.db.exec(`
      create table parent (
        p int,
        q int,
        r int,
        primary key (p, q, r)
      );
      create table child (
        c int,
        b int,
        a int,
        constraint child_parent_fk
          foreign key (c, b, a) references parent (p, q, r)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const childTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.child'
    );

    expect(childTable.foreign_key_constraints).toHaveLength(1);
    expect(childTable.foreign_key_constraints[0]).toEqual(
      expect.objectContaining({
        source_columns: ['c', 'b', 'a'],
        target_columns: ['p', 'q', 'r'],
      })
    );
  });

  test('cross-schema composite FK is schema-qualified on both sides', async () => {
    const { callTool } = await setup();

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

    await project.db.exec(`
      create schema other;
      create table other.parent (
        x int,
        y int,
        primary key (x, y)
      );
      create table child (
        a int,
        b int,
        constraint child_parent_fk
          foreign key (a, b) references other.parent (x, y)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public', 'other'],
        verbose: true,
      },
    });

    const childTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.child'
    );

    expect(childTable.foreign_key_constraints).toHaveLength(1);
    expect(childTable.foreign_key_constraints[0]).toEqual(
      expect.objectContaining({
        source_table: 'public.child',
        source_columns: ['a', 'b'],
        target_table: 'other.parent',
        target_columns: ['x', 'y'],
      })
    );
  });

  test('composite FK referencing a non-primary unique constraint is grouped correctly', async () => {
    const { callTool } = await setup();

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

    await project.db.exec(`
      create table parent (
        id int primary key,
        x int,
        y int,
        constraint parent_xy_unique unique (x, y)
      );
      create table child (
        a int,
        b int,
        constraint child_parent_fk
          foreign key (a, b) references parent (x, y)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const childTable = result.tables.find(
      (t: { name: string }) => t.name === 'public.child'
    );

    expect(childTable.foreign_key_constraints).toHaveLength(1);
    expect(childTable.foreign_key_constraints[0]).toEqual(
      expect.objectContaining({
        name: 'child_parent_fk',
        source_columns: ['a', 'b'],
        target_columns: ['x', 'y'],
      })
    );
  });

  test('same constraint name on different tables is not merged', async () => {
    const { callTool } = await setup();

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

    await project.db.exec(`
      create table parent (
        id int primary key
      );
      create table child_a (
        parent_id int,
        constraint fk_parent
          foreign key (parent_id) references parent (id)
      );
      create table child_b (
        parent_id int,
        constraint fk_parent
          foreign key (parent_id) references parent (id)
      );
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
        verbose: true,
      },
    });

    const childA = result.tables.find(
      (t: { name: string }) => t.name === 'public.child_a'
    );
    const childB = result.tables.find(
      (t: { name: string }) => t.name === 'public.child_b'
    );

    expect(
      childA.foreign_key_constraints.filter(
        (fk: { name: string }) => fk.name === 'fk_parent'
      )
    ).toHaveLength(1);
    expect(
      childB.foreign_key_constraints.filter(
        (fk: { name: string }) => fk.name === 'fk_parent'
      )
    ).toHaveLength(1);
  });

  test('list_tables omits advisory when all tables have RLS enabled', async () => {
    const { callTool } = await setup();

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

    await project.db.exec(`
      create table test (id serial primary key);
      alter table test enable row level security;
    `);

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['public'],
      },
    });

    expect(result.tables[0].rls_enabled).toBe(true);
    expect(result.advisory).toBeUndefined();
  });

  test('cannot apply migration in read-only mode', async () => {
    const { callTool } = await setup({ readOnly: true });

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

    const name = 'test-migration';
    const query =
      'create table test (id integer generated always as identity primary key)';

    const resultPromise = callTool({
      name: 'apply_migration',
      arguments: {
        project_id: project.id,
        name,
        query,
      },
    });

    await expect(resultPromise).rejects.toThrow(
      'Cannot apply migration in read-only mode.'
    );
  });

  test('list tables only under a specific schema', async () => {
    const { callTool } = await setup();

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

    await project.db.exec('create schema test;');
    await project.db.exec(
      'create table public.test_1 (id serial primary key);'
    );
    await project.db.exec('create table test.test_2 (id serial primary key);');

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: ['test'],
      },
    });

    expect(result.tables).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'test.test_2' })])
    );
    expect(result.tables).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'test.test_1' })])
    );
  });

  test('listing all tables excludes system schemas', async () => {
    const { callTool } = await setup();

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

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ schema: 'pg_catalog' }),
      ])
    );

    expect(result).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ schema: 'information_schema' }),
      ])
    );

    expect(result).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ schema: 'pg_toast' })])
    );
  });

  test('list_tables is not vulnerable to SQL injection via schemas parameter', async () => {
    const { callTool } = await setup();

    const org = await createOrganization({
      name: 'SQLi Org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const project = await createProject({
      name: 'SQLi Project',
      region: 'us-east-1',
      organization_id: org.id,
    });
    project.status = 'ACTIVE_HEALTHY';

    // Attempt SQL injection via schemas parameter using payload from HackerOne report
    // This payload attempts to break out of the string and inject a division by zero expression
    // Reference: https://linear.app/supabase/issue/AI-139
    const maliciousSchema = "public') OR (SELECT 1)=1/0--";

    // With proper parameterization, this should NOT throw "division by zero" error
    // The literal schema name doesn't exist, so it should return empty array
    // WITHOUT parameterization, this would throw: "division by zero" error
    const maliciousResult = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: project.id,
        schemas: [maliciousSchema],
      },
    });

    // Should return empty array without errors, proving the SQL injection was prevented
    expect(maliciousResult.tables).toEqual([]);
  });

  test('list extensions', async () => {
    const { callTool } = await setup();

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

    const result = await callTool({
      name: 'list_extensions',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result.extensions).toMatchInlineSnapshot(`
      [
        {
          "comment": "PL/pgSQL procedural language",
          "default_version": "1.0",
          "installed_version": "1.0",
          "name": "plpgsql",
          "schema": "pg_catalog",
        },
      ]
    `);
  });

  test('invalid access token', async () => {
    const { callTool } = await setup({ accessToken: 'bad-token' });

    const listOrganizationsPromise = callTool({
      name: 'list_organizations',
      arguments: {},
    });

    await expect(listOrganizationsPromise).rejects.toThrow('Unauthorized.');
  });

  const projectScopedDbTools = [
    {
      tool: 'execute_sql',
      method: 'post',
      endpoint: '/v1/projects/:projectId/database/query',
      args: (projectId: string) => ({
        project_id: projectId,
        query: 'select 1;',
      }),
    },
    {
      tool: 'list_tables',
      method: 'post',
      endpoint: '/v1/projects/:projectId/database/query',
      args: (projectId: string) => ({ project_id: projectId }),
    },
    {
      tool: 'list_extensions',
      method: 'post',
      endpoint: '/v1/projects/:projectId/database/query',
      args: (projectId: string) => ({ project_id: projectId }),
    },
    {
      tool: 'list_migrations',
      method: 'get',
      endpoint: '/v1/projects/:projectId/database/migrations',
      args: (projectId: string) => ({ project_id: projectId }),
    },
    {
      tool: 'apply_migration',
      method: 'post',
      endpoint: '/v1/projects/:projectId/database/migrations',
      args: (projectId: string) => ({
        project_id: projectId,
        name: 'test-migration',
        query: 'select 1;',
      }),
    },
  ] as const;

  test.each(projectScopedDbTools)(
    'permission denied for $tool suggests checking organization',
    async ({ tool, method, endpoint, args }) => {
      const { callTool } = await setup();

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

      mockServer?.use(
        http[method](`${API_URL}${endpoint}`, () =>
          HttpResponse.json(
            { message: 'You do not have permission to perform this action' },
            { status: 403 }
          )
        )
      );

      const resultPromise = callTool({
        name: tool,
        arguments: args(project.id),
      });

      await expect(resultPromise).rejects.toThrow(
        `You do not have permission to perform this action. Access to project '${project.id}' was denied. If this project exists, your access token may be scoped to a different organization: re-authenticate with the MCP server and select the organization that owns this project.`
      );
    }
  );

  test('permission denied with no upstream message falls back to a generic prefix', async () => {
    const { callTool } = await setup();

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

    // A 403 whose body has no `message` field (the missing-message wrong-org
    // case) falls back to the generic prefix.
    mockServer?.use(
      http.post(`${API_URL}/v1/projects/:projectId/database/query`, () =>
        HttpResponse.json({}, { status: 403 })
      )
    );

    const executeSqlPromise = callTool({
      name: 'execute_sql',
      arguments: {
        project_id: project.id,
        query: 'select 1;',
      },
    });

    await expect(executeSqlPromise).rejects.toThrow(
      `Failed to execute SQL query. Access to project '${project.id}' was denied. If this project exists, your access token may be scoped to a different organization: re-authenticate with the MCP server and select the organization that owns this project.`
    );
  });

  test('invalid sql for apply_migration', async () => {
    const { callTool } = await setup();

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

    const name = 'test-migration';
    const query = 'invalid sql';

    const applyMigrationPromise = callTool({
      name: 'apply_migration',
      arguments: {
        project_id: project.id,
        name,
        query,
      },
    });

    await expect(applyMigrationPromise).rejects.toThrow(
      'syntax error at or near "invalid"'
    );
  });

  test('invalid sql for execute_sql', async () => {
    const { callTool } = await setup();

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

    const query = 'invalid sql';

    const executeSqlPromise = callTool({
      name: 'execute_sql',
      arguments: {
        project_id: project.id,
        query,
      },
    });

    await expect(executeSqlPromise).rejects.toThrow(
      'syntax error at or near "invalid"'
    );
  });

  test('get logs for each service type', async () => {
    const { callTool } = await setup();

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

    const services = [
      'api',
      'branch-action',
      'postgres',
      'edge-function',
      'edge-function-runtime',
      'auth',
      'storage',
      'realtime',
    ] as const;

    for (const service of services) {
      const { result } = await callTool({
        name: 'get_logs',
        arguments: {
          project_id: project.id,
          service,
        },
      });

      expect(result).toContain('untrusted-data');
      expect(result).toContain(JSON.stringify([]));
    }
  });

  test('get logs forwards custom timestamp window', async () => {
    const { callTool } = await setup();

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

    const capturedSearchParams: URLSearchParams[] = [];

    mockServer?.use(
      http.get<{ projectId: string }>(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        ({ params, request }) => {
          expect(params.projectId).toBe(project.id);
          capturedSearchParams.push(new URL(request.url).searchParams);

          return HttpResponse.json([]);
        }
      )
    );

    const isoTimestampStart = '2024-02-01T10:00:00.000Z';
    const isoTimestampEnd = '2024-02-01T11:00:00.000Z';

    const { result } = await callTool({
      name: 'get_logs',
      arguments: {
        project_id: project.id,
        service: 'edge-function-runtime',
        iso_timestamp_start: isoTimestampStart,
        iso_timestamp_end: isoTimestampEnd,
      },
    });

    expect(result).toContain('untrusted-data');
    expect(capturedSearchParams).toHaveLength(1);
    expect(capturedSearchParams[0]?.get('iso_timestamp_start')).toBe(
      isoTimestampStart
    );
    expect(capturedSearchParams[0]?.get('iso_timestamp_end')).toBe(
      isoTimestampEnd
    );
  });

  test('query logs forwards custom sql and defaults the timestamp window', async () => {
    const { callTool } = await setup();

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

    const capturedSearchParams: URLSearchParams[] = [];

    mockServer?.use(
      http.get<{ projectId: string }>(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        ({ params, request }) => {
          expect(params.projectId).toBe(project.id);
          capturedSearchParams.push(new URL(request.url).searchParams);

          return HttpResponse.json([]);
        }
      )
    );

    const sql =
      "select id, timestamp, event_message from logs where source = 'postgres_logs' order by timestamp desc limit 10";

    const before = Date.now();
    const { result } = await callTool({
      name: 'query_logs',
      arguments: {
        project_id: project.id,
        sql,
      },
    });
    const after = Date.now();

    expect(result).toContain('untrusted-data');
    expect(capturedSearchParams).toHaveLength(1);
    expect(capturedSearchParams[0]?.get('sql')).toBe(sql);

    const end = capturedSearchParams[0]?.get('iso_timestamp_end');
    const start = capturedSearchParams[0]?.get('iso_timestamp_start');
    const endMs = Date.parse(end!);

    expect(endMs).toBeGreaterThanOrEqual(before);
    expect(endMs).toBeLessThanOrEqual(after);
    expect(start).toBe(new Date(endMs - 24 * 60 * 60 * 1000).toISOString());
  });

  test('query logs forwards a custom timestamp window', async () => {
    const { callTool } = await setup();

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

    const capturedSearchParams: URLSearchParams[] = [];

    mockServer?.use(
      http.get<{ projectId: string }>(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        ({ request }) => {
          capturedSearchParams.push(new URL(request.url).searchParams);
          return HttpResponse.json([]);
        }
      )
    );

    const isoTimestampStart = '2024-02-01T10:00:00.000Z';
    const isoTimestampEnd = '2024-02-01T11:00:00.000Z';

    await callTool({
      name: 'query_logs',
      arguments: {
        project_id: project.id,
        sql: 'select id from logs limit 1',
        iso_timestamp_start: isoTimestampStart,
        iso_timestamp_end: isoTimestampEnd,
      },
    });

    expect(capturedSearchParams).toHaveLength(1);
    expect(capturedSearchParams[0]?.get('iso_timestamp_start')).toBe(
      isoTimestampStart
    );
    expect(capturedSearchParams[0]?.get('iso_timestamp_end')).toBe(
      isoTimestampEnd
    );
  });

  test('query logs anchors the default start to a supplied end', async () => {
    const { callTool } = await setup();

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

    const capturedSearchParams: URLSearchParams[] = [];

    mockServer?.use(
      http.get<{ projectId: string }>(
        `${API_URL}/v1/projects/:projectId/analytics/endpoints/logs`,
        ({ request }) => {
          capturedSearchParams.push(new URL(request.url).searchParams);
          return HttpResponse.json([]);
        }
      )
    );

    const isoTimestampEnd = '2024-02-01T11:00:00.000Z';

    await callTool({
      name: 'query_logs',
      arguments: {
        project_id: project.id,
        sql: 'select id from logs limit 1',
        iso_timestamp_end: isoTimestampEnd,
      },
    });

    expect(capturedSearchParams).toHaveLength(1);
    expect(capturedSearchParams[0]?.get('iso_timestamp_end')).toBe(
      isoTimestampEnd
    );
    const expectedStart = new Date(
      new Date(isoTimestampEnd).getTime() - 24 * 60 * 60 * 1000
    ).toISOString();
    expect(capturedSearchParams[0]?.get('iso_timestamp_start')).toBe(
      expectedStart
    );
  });

  test('query logs rejects a malformed iso_timestamp_end', async () => {
    const { callTool } = await setup();

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

    await expect(
      callTool({
        name: 'query_logs',
        arguments: {
          project_id: project.id,
          sql: 'select id from logs limit 1',
          iso_timestamp_end: 'not-a-timestamp',
        },
      })
    ).rejects.toThrow(/Invalid ISO datetime/);
  });

  test('query logs rejects a start at or after the end', async () => {
    const { callTool } = await setup();

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

    await expect(
      callTool({
        name: 'query_logs',
        arguments: {
          project_id: project.id,
          sql: 'select id from logs limit 1',
          iso_timestamp_start: '2024-02-01T11:00:00.000Z',
          iso_timestamp_end: '2024-02-01T10:00:00.000Z',
        },
      })
    ).rejects.toThrow(/must be before/);

    await expect(
      callTool({
        name: 'query_logs',
        arguments: {
          project_id: project.id,
          sql: 'select id from logs limit 1',
          iso_timestamp_start: '2024-02-01T10:00:00.000Z',
          iso_timestamp_end: '2024-02-01T10:00:00.000Z',
        },
      })
    ).rejects.toThrow(/must be before/);
  });

  test('query logs rejects an empty sql query', async () => {
    const { callTool } = await setup();

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

    await expect(
      callTool({
        name: 'query_logs',
        arguments: {
          project_id: project.id,
          sql: '',
        },
      })
    ).rejects.toThrow(/too_small|at least 1 character/);
  });

  test('get security advisors', async () => {
    const { callTool } = await setup();

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

    const { result } = await callTool({
      name: 'get_advisors',
      arguments: {
        project_id: project.id,
        type: 'security',
      },
    });

    expect(result).toEqual({ lints: [] });
  });

  test('get advisors groups repeated lints for both security and performance', async () => {
    const platform: SupabasePlatform = {
      debugging: {
        getLogs() {
          throw new Error('Not implemented');
        },
        async getSecurityAdvisors() {
          return {
            lints: [
              {
                name: 'function_search_path_mutable',
                title: 'Function Search Path Mutable',
                level: 'WARN',
                facing: 'EXTERNAL',
                categories: ['SECURITY'],
                description:
                  'Detects functions where the search_path parameter is not set.',
                detail: 'Function `public.a` has a role mutable search_path',
                remediation:
                  'https://supabase.com/docs/guides/database/database-linter',
                cache_key: 'function_search_path_mutable_public_a',
              },
              {
                name: 'function_search_path_mutable',
                title: 'Function Search Path Mutable',
                level: 'WARN',
                facing: 'EXTERNAL',
                categories: ['SECURITY'],
                description:
                  'Detects functions where the search_path parameter is not set.',
                detail: 'Function `public.b` has a role mutable search_path',
                remediation:
                  'https://supabase.com/docs/guides/database/database-linter',
                cache_key: 'function_search_path_mutable_public_b',
              },
            ],
          };
        },
        async getPerformanceAdvisors() {
          return {
            lints: [
              { name: 'unused_index', level: 'INFO', detail: 'index a' },
              { name: 'unused_index', level: 'INFO', detail: 'index b' },
            ],
          };
        },
      },
    };

    const { callTool } = await setup({ platform, features: ['debugging'] });

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

    const { result: security } = await callTool({
      name: 'get_advisors',
      arguments: {
        project_id: project.id,
        type: 'security',
      },
    });

    expect(security).toEqual({
      lints: [
        {
          name: 'function_search_path_mutable',
          title: 'Function Search Path Mutable',
          level: 'WARN',
          facing: 'EXTERNAL',
          categories: ['SECURITY'],
          description:
            'Detects functions where the search_path parameter is not set.',
          remediation:
            'https://supabase.com/docs/guides/database/database-linter',
          count: 2,
          findings: [
            { detail: 'Function `public.a` has a role mutable search_path' },
            { detail: 'Function `public.b` has a role mutable search_path' },
          ],
        },
      ],
    });

    const { result: performance } = await callTool({
      name: 'get_advisors',
      arguments: {
        project_id: project.id,
        type: 'performance',
      },
    });

    expect(performance).toEqual({
      lints: [
        {
          name: 'unused_index',
          level: 'INFO',
          count: 2,
          findings: [{ detail: 'index a' }, { detail: 'index b' }],
        },
      ],
    });
  });

  test('get performance advisors', async () => {
    const { callTool } = await setup();

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

    const { result } = await callTool({
      name: 'get_advisors',
      arguments: {
        project_id: project.id,
        type: 'performance',
      },
    });

    expect(result).toEqual({ lints: [] });
  });

  test('get logs for invalid service type', async () => {
    const { callTool } = await setup();

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

    const invalidService = 'invalid-service';
    const getLogsPromise = callTool({
      name: 'get_logs',
      arguments: {
        project_id: project.id,
        service: invalidService,
      },
    });
    await expect(getLogsPromise).rejects.toThrow('Invalid option');
  });

  test('list edge functions', async () => {
    const { callTool } = await setup();

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

    const indexContent = codeBlock`
      Deno.serve(async (req: Request) => {
        return new Response('Hello world!', { headers: { 'Content-Type': 'text/plain' } })
      });
    `;

    const edgeFunction = await project.deployEdgeFunction(
      {
        name: 'hello-world',
        entrypoint_path: 'index.ts',
      },
      [
        new File([indexContent], 'index.ts', {
          type: 'application/typescript',
        }),
      ]
    );

    const result = await callTool({
      name: 'list_edge_functions',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result.functions).toEqual([
      {
        id: edgeFunction.id,
        slug: edgeFunction.slug,
        version: edgeFunction.version,
        name: edgeFunction.name,
        status: edgeFunction.status,
        entrypoint_path: 'index.ts',
        import_map: false,
        verify_jwt: true,
        created_at: expect.any(Number),
        updated_at: expect.any(Number),
      },
    ]);
  });

  test('get edge function', async () => {
    const { callTool } = await setup();

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

    const indexContent = codeBlock`
      Deno.serve(async (req: Request) => {
        return new Response('Hello world!', { headers: { 'Content-Type': 'text/plain' } })
      });
    `;

    const edgeFunction = await project.deployEdgeFunction(
      {
        name: 'hello-world',
        entrypoint_path: 'index.ts',
      },
      [
        new File([indexContent], 'index.ts', {
          type: 'application/typescript',
        }),
      ]
    );

    const result = await callTool({
      name: 'get_edge_function',
      arguments: {
        project_id: project.id,
        function_slug: edgeFunction.slug,
      },
    });

    expect(result).toEqual({
      id: edgeFunction.id,
      slug: edgeFunction.slug,
      version: edgeFunction.version,
      name: edgeFunction.name,
      status: edgeFunction.status,
      entrypoint_path: 'index.ts',
      import_map: false,
      verify_jwt: true,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
      files: [
        {
          name: 'index.ts',
          content: indexContent,
        },
      ],
    });
  });

  test('deploy new edge function', async () => {
    const { callTool } = await setup();

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

    const functionName = 'hello-world';
    const functionCode = 'console.log("Hello, world!");';

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
        ],
      },
    });

    expect(result).toEqual({
      id: expect.stringMatching(/^.+$/),
      slug: functionName,
      version: 1,
      name: functionName,
      status: 'ACTIVE',
      entrypoint_path: expect.stringMatching(/index\.ts$/),
      import_map: false,
      verify_jwt: true,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });
  });

  test('deploy edge function in read-only mode throws an error', async () => {
    const { callTool } = await setup({ readOnly: true });

    const org = await createOrganization({
      name: 'test-org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const project = await createProject({
      name: 'test-app',
      region: 'us-east-1',
      organization_id: org.id,
    });
    project.status = 'ACTIVE_HEALTHY';

    const functionName = 'hello-world';
    const functionCode = 'console.log("Hello, world!");';

    const result = callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
        ],
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot deploy an edge function in read-only mode.'
    );
  });

  test('deploy edge function validates slug format', async () => {
    const { callTool } = await setup();

    const org = await createOrganization({
      name: 'test-org',
      plan: 'free',
      allowed_release_channels: ['ga'],
    });

    const project = await createProject({
      name: 'test-app',
      region: 'us-east-1',
      organization_id: org.id,
    });
    project.status = 'ACTIVE_HEALTHY';

    const functionInvalidSlugs = [
      // Leading character violations
      '[DEPRECATED] hello-world', // leading bracket
      '_hello-world', // leading underscore
      '-hello-world', // leading hyphen
      '0hello-world', // leading digit
      '#hello-world', // leading special char
      '.hello-world', // leading dot

      // Trailing character violations
      'hello-world ', // trailing space
      'hello-world.', // trailing dot
      'hello-world#', // trailing hash
      'hello-world!', // trailing exclamation
      'hello-world@', // trailing at sign
      'hello-world[', // trailing bracket

      // Whitespace
      'hello world', // space
      'hello\tworld', // tab
      'hello\nworld', // newline
      ' hello-world', // leading space

      // Special characters in body
      'hello.world', // dot
      'hello@world', // at sign
      'hello/world', // slash
      'hello\\world', // backslash
      'hello$world', // dollar sign
      'hello!world', // exclamation

      // Edge cases
      '', // empty string
      ' ', // only space
      '-', // only hyphen
      '_', // only underscore
    ];

    const functionCode = 'console.log("Hello, world!");';

    functionInvalidSlugs
      .map((slug) =>
        callTool({
          name: 'deploy_edge_function',
          arguments: {
            project_id: project.id,
            name: slug,
            files: [
              {
                name: 'index.ts',
                content: functionCode,
              },
            ],
          },
        })
      )
      .forEach(async (result) => {
        await expect(result).rejects.toThrow(
          'Invalid string: must match pattern'
        );
      });
  });

  test('deploy new version of existing edge function', async () => {
    const { callTool } = await setup();
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

    const functionName = 'hello-world';

    const edgeFunction = await project.deployEdgeFunction(
      {
        name: functionName,
        entrypoint_path: 'index.ts',
      },
      [
        new File(['console.log("Hello, world!");'], 'index.ts', {
          type: 'application/typescript',
        }),
      ]
    );

    expect(edgeFunction.version).toEqual(1);

    const originalCreatedAt = edgeFunction.created_at.getTime();
    const originalUpdatedAt = edgeFunction.updated_at.getTime();

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: 'console.log("Hello, world! v2");',
          },
        ],
      },
    });

    expect(result).toEqual({
      id: edgeFunction.id,
      slug: functionName,
      version: 2,
      name: functionName,
      status: 'ACTIVE',
      entrypoint_path: expect.stringMatching(/index\.ts$/),
      import_map: false,
      verify_jwt: true,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });

    expect(result.created_at).toEqual(originalCreatedAt);
    expect(result.updated_at).toBeGreaterThan(originalUpdatedAt);
  });

  test('custom edge function import map', async () => {
    const { callTool } = await setup();

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

    const functionName = 'hello-world';
    const functionCode = 'console.log("Hello, world!");';

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        import_map_path: 'custom-map.json',
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
          {
            name: 'custom-map.json',
            content: '{}',
          },
        ],
      },
    });

    expect(result.import_map).toBe(true);
    expect(result.import_map_path).toMatch(/custom-map\.json$/);
  });

  test('default edge function import map to deno.json', async () => {
    const { callTool } = await setup();

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

    const functionName = 'hello-world';
    const functionCode = 'console.log("Hello, world!");';

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
          {
            name: 'deno.json',
            content: '{}',
          },
        ],
      },
    });

    expect(result.import_map).toBe(true);
    expect(result.import_map_path).toMatch(/deno\.json$/);
  });

  test('default edge function import map to import_map.json', async () => {
    const { callTool } = await setup();

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

    const functionName = 'hello-world';
    const functionCode = 'console.log("Hello, world!");';

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
          {
            name: 'import_map.json',
            content: '{}',
          },
        ],
      },
    });

    expect(result.import_map).toBe(true);
    expect(result.import_map_path).toMatch(/import_map\.json$/);
  });

  test('updating edge function with missing import_map_path defaults to previous value', async () => {
    const { callTool } = await setup();
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

    const functionName = 'hello-world';

    const edgeFunction = await project.deployEdgeFunction(
      {
        name: functionName,
        entrypoint_path: 'index.ts',
        import_map_path: 'custom-map.json',
      },
      [
        new File(['console.log("Hello, world!");'], 'index.ts', {
          type: 'application/typescript',
        }),
        new File(['{}'], 'custom-map.json', {
          type: 'application/json',
        }),
      ]
    );

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: 'console.log("Hello, world! v2");',
          },
          {
            name: 'custom-map.json',
            content: '{}',
          },
        ],
      },
    });

    expect(result.import_map).toBe(true);
    expect(result.import_map_path).toMatch(/custom-map\.json$/);
  });

  test('deploy edge function with verify_jwt disabled', async () => {
    const { callTool } = await setup();

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

    const functionName = 'webhook-handler';
    const functionCode = 'console.log("Webhook handler");';

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        verify_jwt: false,
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
        ],
      },
    });

    expect(result).toEqual({
      id: expect.stringMatching(/^.+$/),
      slug: functionName,
      version: 1,
      name: functionName,
      status: 'ACTIVE',
      entrypoint_path: expect.stringMatching(/index\.ts$/),
      import_map: false,
      verify_jwt: false,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });
  });

  test('deploy edge function with verify_jwt enabled (default)', async () => {
    const { callTool } = await setup();

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

    const functionName = 'authenticated-function';
    const functionCode = 'console.log("Authenticated function");';

    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        files: [
          {
            name: 'index.ts',
            content: functionCode,
          },
        ],
      },
    });

    expect(result.verify_jwt).toBe(true);
  });

  test('update edge function verify_jwt from true to false', async () => {
    const { callTool } = await setup();
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

    const functionName = 'my-function';

    // First deploy with verify_jwt: true (default)
    const edgeFunction = await project.deployEdgeFunction(
      {
        name: functionName,
        entrypoint_path: 'index.ts',
        verify_jwt: true,
      },
      [
        new File(['console.log("v1");'], 'index.ts', {
          type: 'application/typescript',
        }),
      ]
    );

    expect(edgeFunction.verify_jwt).toBe(true);

    // Update with verify_jwt: false
    const result = await callTool({
      name: 'deploy_edge_function',
      arguments: {
        project_id: project.id,
        name: functionName,
        verify_jwt: false,
        files: [
          {
            name: 'index.ts',
            content: 'console.log("v2");',
          },
        ],
      },
    });

    expect(result.verify_jwt).toBe(false);
    expect(result.version).toBe(2);
  });

  test('create branch', async () => {
    const { callTool } = await setup({
      features: ['account', 'branching'],
    });

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

    const confirm_cost_id_result = await callTool({
      name: 'confirm_cost',
      arguments: {
        type: 'branch',
        recurrence: 'hourly',
        amount: BRANCH_COST_HOURLY,
      },
    });

    const branchName = 'test-branch';
    const result = await callTool({
      name: 'create_branch',
      arguments: {
        project_id: project.id,
        name: branchName,
        confirm_cost_id: confirm_cost_id_result.confirmation_id,
      },
    });

    expect(result).toEqual({
      id: expect.stringMatching(/^.+$/),
      name: branchName,
      project_ref: expect.stringMatching(/^.+$/),
      parent_project_ref: project.id,
      is_default: false,
      persistent: false,
      with_data: false,
      status: 'CREATING_PROJECT',
      created_at: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
      ),
      updated_at: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
      ),
    });
  });

  test('create branch in read-only mode throws an error', async () => {
    const { callTool } = await setup({
      readOnly: true,
      features: ['account', 'branching'],
    });

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

    const confirm_cost_id_result = await callTool({
      name: 'confirm_cost',
      arguments: {
        type: 'branch',
        recurrence: 'hourly',
        amount: BRANCH_COST_HOURLY,
      },
    });

    const branchName = 'test-branch';
    const result = callTool({
      name: 'create_branch',
      arguments: {
        project_id: project.id,
        name: branchName,
        confirm_cost_id: confirm_cost_id_result.confirmation_id,
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot create a branch in read-only mode.'
    );
  });

  test('create branch without cost confirmation fails', async () => {
    const { callTool } = await setup({ features: ['branching'] });

    const org = await createOrganization({
      name: 'Paid Org',
      plan: 'pro',
      allowed_release_channels: ['ga'],
    });

    const project = await createProject({
      name: 'Project 1',
      region: 'us-east-1',
      organization_id: org.id,
    });
    project.status = 'ACTIVE_HEALTHY';

    const branchName = 'test-branch';
    const createBranchPromise = callTool({
      name: 'create_branch',
      arguments: {
        project_id: project.id,
        name: branchName,
      },
    });

    await expect(createBranchPromise).rejects.toThrow(
      'User must confirm understanding of costs before creating a branch.'
    );
  });

  test('delete branch', async () => {
    const { callTool } = await setup({
      features: ['account', 'branching'],
    });

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

    const confirm_cost_id_result = await callTool({
      name: 'confirm_cost',
      arguments: {
        type: 'branch',
        recurrence: 'hourly',
        amount: BRANCH_COST_HOURLY,
      },
    });

    const branch = await callTool({
      name: 'create_branch',
      arguments: {
        project_id: project.id,
        name: 'test-branch',
        confirm_cost_id: confirm_cost_id_result.confirmation_id,
      },
    });

    const listBranchesResult = await callTool({
      name: 'list_branches',
      arguments: {
        project_id: project.id,
      },
    });

    expect(listBranchesResult.branches).toContainEqual(
      expect.objectContaining({ id: branch.id })
    );
    expect(listBranchesResult.branches).toHaveLength(2);

    await callTool({
      name: 'delete_branch',
      arguments: {
        branch_id: branch.id,
      },
    });

    const listBranchesResultAfterDelete = await callTool({
      name: 'list_branches',
      arguments: {
        project_id: project.id,
      },
    });

    expect(listBranchesResultAfterDelete.branches).not.toContainEqual(
      expect.objectContaining({ id: branch.id })
    );
    expect(listBranchesResultAfterDelete.branches).toHaveLength(1);

    const mainBranch = listBranchesResultAfterDelete.branches.at(-1);

    const deleteBranchPromise = callTool({
      name: 'delete_branch',
      arguments: {
        branch_id: mainBranch.id,
      },
    });

    await expect(deleteBranchPromise).rejects.toThrow(
      'Cannot delete the default branch.'
    );
  });

  test('delete branch in read-only mode throws an error', async () => {
    const { callTool } = await setup({
      readOnly: true,
      features: ['account', 'branching'],
    });

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

    const branch = await createBranch({
      name: 'test-branch',
      parent_project_ref: project.id,
    });

    const listBranchesResult = await callTool({
      name: 'list_branches',
      arguments: {
        project_id: project.id,
      },
    });

    expect(listBranchesResult.branches).toHaveLength(1);
    expect(listBranchesResult.branches).toContainEqual(
      expect.objectContaining({ id: branch.id })
    );

    const result = callTool({
      name: 'delete_branch',
      arguments: {
        branch_id: branch.id,
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot delete a branch in read-only mode.'
    );
  });

  test('list branches', async () => {
    const { callTool } = await setup({ features: ['branching'] });

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

    const result = await callTool({
      name: 'list_branches',
      arguments: {
        project_id: project.id,
      },
    });

    expect(result.branches).toStrictEqual([]);
  });

  test('merge branch', async () => {
    const { callTool } = await setup({
      features: ['account', 'branching', 'database'],
    });

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

    const confirm_cost_id_result = await callTool({
      name: 'confirm_cost',
      arguments: {
        type: 'branch',
        recurrence: 'hourly',
        amount: BRANCH_COST_HOURLY,
      },
    });

    const branch = await callTool({
      name: 'create_branch',
      arguments: {
        project_id: project.id,
        name: 'test-branch',
        confirm_cost_id: confirm_cost_id_result.confirmation_id,
      },
    });

    const migrationName = 'sample_migration';
    const migrationQuery =
      'create table sample (id integer generated always as identity primary key)';
    await callTool({
      name: 'apply_migration',
      arguments: {
        project_id: branch.project_ref,
        name: migrationName,
        query: migrationQuery,
      },
    });

    await callTool({
      name: 'merge_branch',
      arguments: {
        branch_id: branch.id,
      },
    });

    // Check that the migration was applied to the parent project
    const listResult = await callTool({
      name: 'list_migrations',
      arguments: {
        project_id: project.id,
      },
    });

    expect(listResult.migrations).toContainEqual({
      name: migrationName,
      version: expect.stringMatching(/^\d{14}$/),
    });
  });

  test('merge branch in read-only mode throws an error', async () => {
    const { callTool } = await setup({
      readOnly: true,
      features: ['account', 'branching', 'database'],
    });

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

    const branch = await createBranch({
      name: 'test-branch',
      parent_project_ref: project.id,
    });

    const result = callTool({
      name: 'merge_branch',
      arguments: {
        branch_id: branch.id,
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot merge a branch in read-only mode.'
    );
  });

  test('reset branch', async () => {
    const { callTool } = await setup({
      features: ['account', 'branching', 'database'],
    });

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

    const confirm_cost_id_result = await callTool({
      name: 'confirm_cost',
      arguments: {
        type: 'branch',
        recurrence: 'hourly',
        amount: BRANCH_COST_HOURLY,
      },
    });

    const branch = await callTool({
      name: 'create_branch',
      arguments: {
        project_id: project.id,
        name: 'test-branch',
        confirm_cost_id: confirm_cost_id_result.confirmation_id,
      },
    });

    // Create a table via execute_sql so that it is untracked
    const query =
      'create table test_untracked (id integer generated always as identity primary key)';
    await callTool({
      name: 'execute_sql',
      arguments: {
        project_id: branch.project_ref,
        query,
      },
    });

    const firstTablesResult = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: branch.project_ref,
      },
    });

    expect(firstTablesResult.tables).toContainEqual(
      expect.objectContaining({ name: 'public.test_untracked' })
    );

    await callTool({
      name: 'reset_branch',
      arguments: {
        branch_id: branch.id,
      },
    });

    const secondTablesResult = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: branch.project_ref,
      },
    });

    // Expect the untracked table to be removed after reset
    expect(secondTablesResult.tables).not.toContainEqual(
      expect.objectContaining({ name: 'public.test_untracked' })
    );
  });

  test('reset branch in read-only mode throws an error', async () => {
    const { callTool } = await setup({
      readOnly: true,
      features: ['account', 'branching', 'database'],
    });

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

    const branch = await createBranch({
      name: 'test-branch',
      parent_project_ref: project.id,
    });

    const result = callTool({
      name: 'reset_branch',
      arguments: {
        branch_id: branch.id,
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot reset a branch in read-only mode.'
    );
  });

  test('revert migrations', async () => {
    const { callTool } = await setup({
      features: ['account', 'branching', 'database'],
    });

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

    const confirm_cost_id_result = await callTool({
      name: 'confirm_cost',
      arguments: {
        type: 'branch',
        recurrence: 'hourly',
        amount: BRANCH_COST_HOURLY,
      },
    });

    const branch = await callTool({
      name: 'create_branch',
      arguments: {
        project_id: project.id,
        name: 'test-branch',
        confirm_cost_id: confirm_cost_id_result.confirmation_id,
      },
    });

    const migrationName = 'sample_migration';
    const migrationQuery =
      'create table sample (id integer generated always as identity primary key)';
    await callTool({
      name: 'apply_migration',
      arguments: {
        project_id: branch.project_ref,
        name: migrationName,
        query: migrationQuery,
      },
    });

    // Check that migration has been applied to the branch
    const firstListResult = await callTool({
      name: 'list_migrations',
      arguments: {
        project_id: branch.project_ref,
      },
    });

    expect(firstListResult.migrations).toContainEqual({
      name: migrationName,
      version: expect.stringMatching(/^\d{14}$/),
    });

    const firstTablesResult = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: branch.project_ref,
      },
    });

    expect(firstTablesResult.tables).toContainEqual(
      expect.objectContaining({ name: 'public.sample' })
    );

    await callTool({
      name: 'reset_branch',
      arguments: {
        branch_id: branch.id,
        migration_version: '0',
      },
    });

    // Check that all migrations have been reverted
    const secondListResult = await callTool({
      name: 'list_migrations',
      arguments: {
        project_id: branch.project_ref,
      },
    });

    expect(secondListResult.migrations).toStrictEqual([]);

    const secondTablesResult = await callTool({
      name: 'list_tables',
      arguments: {
        project_id: branch.project_ref,
      },
    });

    expect(secondTablesResult.tables).not.toContainEqual(
      expect.objectContaining({ name: 'public.sample' })
    );
  });

  test('rebase branch', async () => {
    const { callTool } = await setup({
      features: ['account', 'branching', 'database'],
    });

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

    const confirm_cost_id_result = await callTool({
      name: 'confirm_cost',
      arguments: {
        type: 'branch',
        recurrence: 'hourly',
        amount: BRANCH_COST_HOURLY,
      },
    });

    const branch = await callTool({
      name: 'create_branch',
      arguments: {
        project_id: project.id,
        name: 'test-branch',
        confirm_cost_id: confirm_cost_id_result.confirmation_id,
      },
    });

    const migrationName = 'sample_migration';
    const migrationQuery =
      'create table sample (id integer generated always as identity primary key)';
    await callTool({
      name: 'apply_migration',
      arguments: {
        project_id: project.id,
        name: migrationName,
        query: migrationQuery,
      },
    });

    await callTool({
      name: 'rebase_branch',
      arguments: {
        branch_id: branch.id,
      },
    });

    // Check that the production migration was applied to the branch
    const listResult = await callTool({
      name: 'list_migrations',
      arguments: {
        project_id: branch.project_ref,
      },
    });

    expect(listResult.migrations).toContainEqual({
      name: migrationName,
      version: expect.stringMatching(/^\d{14}$/),
    });
  });

  test('rebase branch in read-only mode throws an error', async () => {
    const { callTool } = await setup({
      readOnly: true,
      features: ['account', 'branching', 'database'],
    });

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

    const branch = await createBranch({
      name: 'test-branch',
      parent_project_ref: project.id,
    });

    const result = callTool({
      name: 'rebase_branch',
      arguments: {
        branch_id: branch.id,
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot rebase a branch in read-only mode.'
    );
  });

  // We use snake_case because it aligns better with most MCP clients
  test('all tools follow snake_case naming convention', async () => {
    const { client } = await setup();

    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.name, 'expected tool name to be snake_case').toMatch(
        /^[a-z0-9_]+$/
      );

      const parameterNames = Object.keys(tool.inputSchema.properties ?? {});
      for (const name of parameterNames) {
        expect(name, 'expected parameter to be snake_case').toMatch(
          /^[a-z0-9_]+$/
        );
      }
    }
  });

  test('all tools provide annotations', async () => {
    const { client } = await setup();

    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} tool`).toBeDefined();
      expect(tool.annotations!.title, `${tool.name} tool`).toBeDefined();
      expect(tool.annotations!.readOnlyHint, `${tool.name} tool`).toBeDefined();
      expect(
        tool.annotations!.destructiveHint,
        `${tool.name} tool`
      ).toBeDefined();
      expect(
        tool.annotations!.idempotentHint,
        `${tool.name} tool`
      ).toBeDefined();
      expect(
        tool.annotations!.openWorldHint,
        `${tool.name} tool`
      ).toBeDefined();
    }
  });

  test('all tools are included in supabaseMcpToolSchemas registry, including hidden tools', async () => {
    // Enable all features to ensure we check all possible tools
    const { client } = await setup({
      features: [
        'docs',
        'account',
        'database',
        'debugging',
        'development',
        'functions',
        'branching',
        'storage',
      ],
    });

    const { tools } = await client.listTools();

    // Check that every tool from the MCP server exists in the registry
    for (const tool of tools) {
      expect(
        supabaseMcpToolSchemas,
        `Tool "${tool.name}" should be in supabaseMcpToolSchemas registry`
      ).toHaveProperty(tool.name);
    }

    // Also verify that the registry doesn't have unexpected extra entries
    // (tools that don't exist in the server). A registry entry is allowed to
    // be missing from tools/list if its tool def is marked `hidden` — it
    // stays in the registry for typed access while being delisted from live
    // discovery (see CONTRIBUTING.md's tool deprecation guidance) — or if
    // its visibility is capability-dependent rather than a static def
    // property, like get_logs (hidden only when the platform also offers
    // query_logs).
    const registryToolNames = Object.keys(supabaseMcpToolSchemas);
    const serverToolNames = tools.map((t) => t.name);
    const conditionallyHiddenToolNames = new Set(['get_logs']);

    const extraToolsInRegistry = registryToolNames.filter(
      (name) => !serverToolNames.includes(name)
    );

    const unexpectedExtraTools = extraToolsInRegistry.filter(
      (name) =>
        !supabaseMcpToolSchemas[name as keyof typeof supabaseMcpToolSchemas]
          .hidden && !conditionallyHiddenToolNames.has(name)
    );

    expect(
      unexpectedExtraTools,
      'Registry should not contain tools that are not in the MCP server when all features are enabled, unless the tool is marked `hidden`'
    ).toEqual([]);
  });

  test('tool result content is valid JSON', async () => {
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

    const { client } = await setup({ projectId: project.id });
    const resultUntyped = await client.callTool({
      name: 'list_tables',
      arguments: { schemas: ['public'] },
    });

    const result = resultUntyped;
    const firstContent = result.content.at(0);
    if (!firstContent) {
      throw new Error('Expected content in tool response');
    }
    if (firstContent.type !== 'text') {
      throw new Error('Expected text content in tool response');
    }
    const parsedContent = JSON.parse(firstContent.text);
    expect(parsedContent).toBeTypeOf('object');
  });

  test('read-only mode excludes write tools from tools/list', async () => {
    const { callTool, client } = await setup({
      readOnly: true,
      features: [
        'docs',
        'account',
        'database',
        'debugging',
        'development',
        'functions',
        'branching',
        'storage',
      ],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toContain('execute_sql');
    expect(toolNames).not.toContain('apply_migration');
    expect(toolNames).not.toContain('deploy_edge_function');
    expect(toolNames).not.toContain('create_branch');
    expect(toolNames).not.toContain('delete_branch');
    expect(toolNames).not.toContain('update_storage_config');

    expect(
      tools
        .filter((tool) => tool.annotations?.readOnlyHint === false)
        .map((tool) => tool.name)
    ).toEqual([]);

    const result = callTool({
      name: 'apply_migration',
      arguments: {
        project_id: 'test-project-ref',
        name: 'test-migration',
        query: 'create table test (id int)',
      },
    });

    await expect(result).rejects.toThrow(
      'Cannot apply migration in read-only mode.'
    );
  });
});

describe('feature groups', () => {
  test('account tools', async () => {
    const { client } = await setup({
      features: ['account'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'list_organizations',
      'get_organization',
      'list_projects',
      'get_project',
      'get_cost',
      'confirm_cost',
      'create_project',
      'pause_project',
      'restore_project',
    ]);
  });

  test('database tools', async () => {
    const { client } = await setup({
      features: ['database'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'list_tables',
      'list_extensions',
      'list_migrations',
      'apply_migration',
      'execute_sql',
    ]);
  });

  test('debugging tools hide get_logs in favor of query_logs when the platform supports it', async () => {
    const { client } = await setup({
      features: ['debugging'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(['query_logs', 'get_advisors']);
  });

  test('get_logs stays callable via tools/call even while hidden from tools/list', async () => {
    const { callTool } = await setup({
      features: ['debugging'],
    });

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

    const { result } = await callTool({
      name: 'get_logs',
      arguments: {
        project_id: project.id,
        service: 'api',
      },
    });

    expect(result).toContain('untrusted-data');
  });

  test('debugging tools show get_logs when the platform does not implement query_logs', async () => {
    const platform: SupabasePlatform = {
      debugging: {
        getLogs() {
          throw new Error('Not implemented');
        },
        getSecurityAdvisors() {
          throw new Error('Not implemented');
        },
        getPerformanceAdvisors() {
          throw new Error('Not implemented');
        },
      },
    };

    const { client } = await setup({ platform, features: ['debugging'] });
    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(['get_logs', 'get_advisors']);
  });

  test('query_logs advertises the ClickHouse dialect by default', async () => {
    const { client } = await setup({ features: ['debugging'] });

    const { tools } = await client.listTools();
    const queryLogs = tools.find((tool) => tool.name === 'query_logs');
    const sqlDescription = (queryLogs?.inputSchema.properties as any)?.sql
      ?.description as string | undefined;

    expect(queryLogs?.description).toContain('ClickHouse');
    expect(sqlDescription).toContain("log_attributes['<key>']");
  });

  test('query_logs advertises the BigQuery dialect when the platform declares it', async () => {
    const platform: SupabasePlatform = {
      debugging: {
        logsDialect: 'bigquery',
        getLogs() {
          throw new Error('Not implemented');
        },
        queryLogs() {
          throw new Error('Not implemented');
        },
        getSecurityAdvisors() {
          throw new Error('Not implemented');
        },
        getPerformanceAdvisors() {
          throw new Error('Not implemented');
        },
      },
    };

    const { client } = await setup({ platform, features: ['debugging'] });

    const { tools } = await client.listTools();
    const queryLogs = tools.find((tool) => tool.name === 'query_logs');
    const sqlDescription = (queryLogs?.inputSchema.properties as any)?.sql
      ?.description as string | undefined;

    expect(queryLogs?.description).toContain('BigQuery');
    expect(queryLogs?.description).not.toContain('ClickHouse');
    expect(sqlDescription).toContain('unnest(metadata)');
    expect(sqlDescription).not.toContain('log_attributes');
    // Self-hosted BigQuery (Logflare) does not serve these sources, so the hint
    // must not advertise them (see apps/studio/lib/api/self-hosted/logs.ts).
    expect(sqlDescription).not.toContain('function_logs');
    expect(sqlDescription).not.toContain('workflow_run_logs');
  });

  test('query_logs falls back to the ClickHouse dialect when logsDialect is unset', async () => {
    const platform: SupabasePlatform = {
      debugging: {
        getLogs() {
          throw new Error('Not implemented');
        },
        queryLogs() {
          throw new Error('Not implemented');
        },
        getSecurityAdvisors() {
          throw new Error('Not implemented');
        },
        getPerformanceAdvisors() {
          throw new Error('Not implemented');
        },
      },
    };

    const { client } = await setup({ platform, features: ['debugging'] });

    const { tools } = await client.listTools();
    const queryLogs = tools.find((tool) => tool.name === 'query_logs');
    const sqlDescription = (queryLogs?.inputSchema.properties as any)?.sql
      ?.description as string | undefined;

    expect(queryLogs?.description).toContain('ClickHouse');
    expect(sqlDescription).toContain("log_attributes['<key>']");
  });

  test('development tools', async () => {
    const { client } = await setup({
      features: ['development'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'get_project_url',
      'get_publishable_keys',
      'generate_typescript_types',
    ]);
  });

  test('docs tools', async () => {
    const { client } = await setup({
      features: ['docs'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(['search_docs']);
  });

  test('functions tools', async () => {
    const { client } = await setup({
      features: ['functions'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'list_edge_functions',
      'get_edge_function',
      'deploy_edge_function',
    ]);
  });

  test('branching tools', async () => {
    const { client } = await setup({
      features: ['branching'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'create_branch',
      'list_branches',
      'delete_branch',
      'merge_branch',
      'reset_branch',
      'rebase_branch',
    ]);
  });

  test('storage tools', async () => {
    const { client } = await setup({
      features: ['storage'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'list_storage_buckets',
      'get_storage_config',
      'update_storage_config',
    ]);
  });

  test('invalid group fails', async () => {
    const setupPromise = setup({
      features: ['my-invalid-group'],
    });

    await expect(setupPromise).rejects.toThrow('Invalid input');
  });

  test('duplicate group behaves like single group', async () => {
    const { client: duplicateClient } = await setup({
      features: ['account', 'account'],
    });

    const { tools } = await duplicateClient.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'list_organizations',
      'get_organization',
      'list_projects',
      'get_project',
      'get_cost',
      'confirm_cost',
      'create_project',
      'pause_project',
      'restore_project',
    ]);
  });

  test('tools filtered to available platform operations', async () => {
    const platform: SupabasePlatform = {
      database: {
        executeSql() {
          throw new Error('Not implemented');
        },
        listMigrations() {
          throw new Error('Not implemented');
        },
        applyMigration() {
          throw new Error('Not implemented');
        },
      },
    };

    const { client } = await setup({ platform });
    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'search_docs',
      'list_tables',
      'list_extensions',
      'list_migrations',
      'apply_migration',
      'execute_sql',
    ]);
  });

  test('unimplemented feature group produces custom error message', async () => {
    const platform: SupabasePlatform = {
      database: {
        executeSql() {
          throw new Error('Not implemented');
        },
        listMigrations() {
          throw new Error('Not implemented');
        },
        applyMigration() {
          throw new Error('Not implemented');
        },
      },
    };

    const setupPromise = setup({ platform, features: ['account'] });

    await expect(setupPromise).rejects.toThrow(
      "This platform does not support the 'account' feature group"
    );
  });
});

describe('project scoped tools', () => {
  test('no account level tools should exist', async () => {
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

    const { client } = await setup({ projectId: project.id });

    const result = await client.listTools();

    // `get_cost` and `confirm_cost` are not listed here: they stay
    // available in project scope (when branching is enabled) so that
    // `create_branch` remains callable.
    const accountLevelToolNames = [
      'list_organizations',
      'get_organization',
      'list_projects',
      'get_project',
      'create_project',
      'pause_project',
      'restore_project',
    ];

    const toolNames = result.tools.map((tool) => tool.name);

    for (const accountLevelToolName of accountLevelToolNames) {
      expect(
        toolNames,
        `tool ${accountLevelToolName} should not be available in project scope`
      ).not.toContain(accountLevelToolName);
    }
  });

  test('cost tools are available when branching is enabled', async () => {
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

    const { client } = await setup({ projectId: project.id });

    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name);

    expect(toolNames).toContain('get_cost');
    expect(toolNames).toContain('confirm_cost');
  });

  test('cost tools are not available when branching is disabled', async () => {
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

    const { client } = await setup({
      projectId: project.id,
      features: ['database', 'docs'],
    });

    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name);

    expect(toolNames).not.toContain('get_cost');
    expect(toolNames).not.toContain('confirm_cost');
  });

  test('create branch using the scoped cost tools', async () => {
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

    const { callTool } = await setup({ projectId: project.id });

    const cost = await callTool({
      name: 'get_cost',
      arguments: {
        type: 'branch',
        organization_id: org.id,
      },
    });

    expect(cost).toEqual({
      type: 'branch',
      recurrence: 'hourly',
      amount: BRANCH_COST_HOURLY,
    });

    const confirm_cost_id_result = await callTool({
      name: 'confirm_cost',
      arguments: cost,
    });

    const branchName = 'test-branch';
    const branch = await callTool({
      name: 'create_branch',
      arguments: {
        name: branchName,
        confirm_cost_id: confirm_cost_id_result.confirmation_id,
      },
    });

    expect(branch).toEqual(
      expect.objectContaining({
        name: branchName,
        parent_project_ref: project.id,
      })
    );
  });

  test('branch workflow: create, list, and merge on a scoped connection', async () => {
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

    const { callTool } = await setup({
      projectId: project.id,
      features: ['branching', 'database'],
    });

    const confirm_cost_id_result = await callTool({
      name: 'confirm_cost',
      arguments: {
        type: 'branch',
        recurrence: 'hourly',
        amount: BRANCH_COST_HOURLY,
      },
    });

    const branch = await callTool({
      name: 'create_branch',
      arguments: {
        name: 'feature-branch',
        confirm_cost_id: confirm_cost_id_result.confirmation_id,
      },
    });

    const listResult = await callTool({
      name: 'list_branches',
      arguments: {},
    });

    expect(listResult.branches).toContainEqual(
      expect.objectContaining({ id: branch.id })
    );

    // Simulate a migration applied on the branch. In a real workflow this
    // happens through a connection scoped to the branch's project_ref.
    const branchProject = mockProjects.get(branch.project_ref);
    if (!branchProject) {
      throw new Error('branch project not found');
    }
    const migrationName = 'sample_migration';
    const migrationVersion = '20240101000000';
    branchProject.migrations.push({
      version: migrationVersion,
      name: migrationName,
      query:
        'create table sample (id integer generated always as identity primary key)',
    });

    await callTool({
      name: 'merge_branch',
      arguments: {
        branch_id: branch.id,
      },
    });

    // Check that the migration was applied to the scoped parent project
    const migrationsResult = await callTool({
      name: 'list_migrations',
      arguments: {},
    });

    expect(migrationsResult.migrations).toContainEqual({
      name: migrationName,
      version: migrationVersion,
    });
  });

  test('no tool should accept a project_id', async () => {
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

    const { client } = await setup({ projectId: project.id });

    const result = await client.listTools();

    expect(result.tools).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);

    for (const tool of result.tools) {
      const schemaProperties = tool.inputSchema.properties ?? {};
      expect(
        'project_id' in schemaProperties,
        `tool ${tool.name} should not accept a project_id`
      ).toBe(false);
    }
  });

  test('invalid project ID should throw an error', async () => {
    const { callTool } = await setup({ projectId: 'invalid-project-id' });

    const listTablesPromise = callTool({
      name: 'list_tables',
      arguments: {
        schemas: ['public'],
      },
    });

    await expect(listTablesPromise).rejects.toThrow('Project not found');
  });

  test('passing project_id to a tool should throw an error', async () => {
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

    const { callTool } = await setup({ projectId: project.id });

    const listTablesPromise = callTool({
      name: 'list_tables',
      arguments: {
        project_id: 'my-project-id',
        schemas: ['public'],
      },
    });

    await expect(listTablesPromise).rejects.toThrow('Unrecognized key');
  });

  test('listing tables implicitly uses the scoped project_id', async () => {
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

    project.db
      .sql`create table test (id integer generated always as identity primary key)`;

    const { callTool } = await setup({ projectId: project.id });

    const result = await callTool({
      name: 'list_tables',
      arguments: {
        schemas: ['public'],
        verbose: true,
      },
    });

    expect(result.tables).toEqual([
      expect.objectContaining({
        name: 'public.test',
        columns: [
          expect.objectContaining({
            name: 'id',
            options: expect.arrayContaining(['identity']),
          }),
        ],
      }),
    ]);
  });
});

describe('docs tools', () => {
  test('gets content', async () => {
    const { callTool } = await setup();
    const query = stripIndent`
      query ContentQuery {
        searchDocs(query: "typescript") {
          nodes {
            title
            href
          }
        }
      }
    `;

    const result = await callTool({
      name: 'search_docs',
      arguments: {
        graphql_query: query,
      },
    });

    expect(result).toEqual({ result: { dummy: true } });
  });

  test('tool description contains schema', async () => {
    const { client } = await setup();

    const { tools } = await client.listTools();

    const tool = tools.find((tool) => tool.name === 'search_docs');

    if (!tool) {
      throw new Error('tool not found');
    }

    if (!tool.description) {
      throw new Error('tool description not found');
    }

    const minifiedSchema = gqlmin(contentApiMockSchema);
    expect(tool.description.includes(minifiedSchema)).toBe(true);
  });

  test('schema is only loaded when listing tools', async () => {
    const { client, callTool } = await setup();

    expect(mockContentApiSchemaLoadCount.value).toBe(0);

    // "tools/list" requests fetch the schema
    await client.listTools();
    expect(mockContentApiSchemaLoadCount.value).toBe(1);

    // "tools/call" should not fetch the schema again
    await callTool({
      name: 'search_docs',
      arguments: {
        graphql_query: '{ searchDocs(query: "test") { nodes { title } } }',
      },
    });
    expect(mockContentApiSchemaLoadCount.value).toBe(1);

    // Additional "tools/list" requests fetch the schema again
    await client.listTools();
    expect(mockContentApiSchemaLoadCount.value).toBe(2);
  });
});

describe('zod registry', () => {
  // Zod schemas with `.describe()` auto-register in the global registry. If schemas are defined
  // inside functions (rather than at module level), new instances register on every call,
  // causing unbounded memory growth.
  test('creating multiple servers does not cause unbounded registry growth', async () => {
    const addSpy = vi.spyOn(globalRegistry, 'add');

    for (let i = 0; i < 9; i++) {
      const { client } = await setup();
      await client.listTools();
    }

    const registryAdditions = addSpy.mock.calls.length;
    expect(registryAdditions).toBe(0);

    addSpy.mockRestore();
  });
});
