import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createOrganization, createProject } from '../test/mocks.js';
import { createServerHarness } from '../test/server-harness.js';
import { BRANCH_COST_HOURLY, PROJECT_COST_MONTHLY } from './pricing.js';

const harness = createServerHarness();
const setup = harness.setup;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

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
});
