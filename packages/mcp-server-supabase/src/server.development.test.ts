import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createOrganization,
  createProject,
  createProjectFixture,
} from '../test/mocks.js';
import { createServerHarness } from '../test/server-harness.js';

const harness = createServerHarness();
const setup = harness.setup;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

describe('tools', () => {
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
});

describe('generate_typescript_types', () => {
  test('omits included_schemas when schemas is not given', async () => {
    const { project } = await createProjectFixture();
    const { callTool } = await setup();

    const result = await callTool({
      name: 'generate_typescript_types',
      arguments: { project_id: project.id },
    });

    expect(result.types).toContain('// included_schemas: (not sent)');
  });

  test('passes schemas through as included_schemas', async () => {
    const { project } = await createProjectFixture();
    const { callTool } = await setup();

    const result = await callTool({
      name: 'generate_typescript_types',
      arguments: { project_id: project.id, schemas: ['public', 'mcp_types'] },
    });

    expect(result.types).toContain('// included_schemas: public,mcp_types');
  });

  test('rejects an empty schemas list', async () => {
    const { project } = await createProjectFixture();
    const { callTool } = await setup();

    const result = callTool({
      name: 'generate_typescript_types',
      arguments: { project_id: project.id, schemas: [] },
    });

    await expect(result).rejects.toThrow(
      'Too small: expected array to have >=1 items'
    );
  });

  test('advertises schemas as an optional array of schema names', async () => {
    const { client } = await setup();

    const { tools } = await client.listTools();
    const tool = tools.find(
      (tool) => tool.name === 'generate_typescript_types'
    );

    expect(tool?.inputSchema.properties?.schemas).toMatchObject({
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    });
    expect(tool?.inputSchema.required ?? []).not.toContain('schemas');
  });
});
