import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createOrganization, createProject } from '../test/mocks.js';
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
