import {
  contentApiMockSchema,
  createOrganization,
  createProject,
  createProjectFixture,
  mockContentApiSchemaLoadCount,
} from '../test/mocks.js';
import { createServerHarness } from '../test/server-harness.js';
import type { SupabasePlatform } from './platform/types.js';
import { instructions } from './server.js';
import { supabaseMcpToolSchemas } from './tools/tool-schemas.js';
import { stripIndent } from 'common-tags';
import gqlmin from 'gqlmin';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { globalRegistry } from 'zod/v4';

const harness = createServerHarness();
const setup = harness.setup;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

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

  describe('create_project cost confirmation via elicitation', () => {
    async function createOrganizationWithBillableNextProject() {
      const org = await createOrganization({
        name: 'Paid Org',
        plan: 'pro',
        allowed_release_channels: ['ga'],
      });
      const existingProject = await createProject({
        name: 'Existing Project',
        region: 'us-east-1',
        organization_id: org.id,
      });
      existingProject.status = 'ACTIVE_HEALTHY';

      return { org, existingProject };
    }

    test('create_project requires confirm_cost_id when cost confirmation is not configured', async () => {
      const { client } = await setup();

      const { tools } = await client.listTools();
      const createProjectTool = tools.find(
        (tool) => tool.name === 'create_project'
      );

      expect(createProjectTool?.inputSchema.required).toContain(
        'confirm_cost_id'
      );
    });

    test('create_project advertises confirm_cost_id as optional when cost confirmation is configured', async () => {
      const { client } = await setup({
        elicitation: {
          requestState: ELICITATION_REQUEST_STATE,
          confirmation: COST_CONFIRMATION,
        },
      });

      const { tools } = await client.listTools();
      const createProjectTool = tools.find(
        (tool) => tool.name === 'create_project'
      );

      expect(createProjectTool?.inputSchema.required).not.toContain(
        'confirm_cost_id'
      );
    });

    test('hides cost tools from a form-capable client', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
      });
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).not.toContain('get_cost');
      expect(names).not.toContain('confirm_cost');
      expect(names).toContain('create_project');
    });

    test('omits confirm_cost_id from create_project for a form-capable client', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
      });

      const { tools } = await client.listTools();
      const createProjectTool = tools.find(
        (tool) => tool.name === 'create_project'
      );

      expect(createProjectTool?.inputSchema.properties).not.toHaveProperty(
        'confirm_cost_id'
      );
    });

    test('omits confirm_cost_id from create_branch for a form-capable client', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
      });

      const { tools } = await client.listTools();
      const createBranchTool = tools.find(
        (tool) => tool.name === 'create_branch'
      );

      expect(createBranchTool?.inputSchema.properties).not.toHaveProperty(
        'confirm_cost_id'
      );
    });

    test('narrows cost tools to branch while create_branch still needs confirm_cost_id', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitation: {
          requestState: ELICITATION_REQUEST_STATE,
          confirmation: {
            ...COST_CONFIRMATION,
            enabledTools: ['create_project'],
          },
        },
      });

      const { tools } = await client.listTools();

      for (const name of ['get_cost', 'confirm_cost']) {
        const tool = tools.find((tool) => tool.name === name);
        expect(tool?.inputSchema.properties?.type).toStrictEqual({
          type: 'string',
          enum: ['branch'],
        });
      }
    });

    test('lists cost tools for a 2025-era client that declares elicitation', async () => {
      const { client } = await setup({
        elicitation: {
          requestState: ELICITATION_REQUEST_STATE,
          confirmation: COST_CONFIRMATION,
        },
        clientCapabilities: { elicitation: { form: {} } },
      });

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toContain('get_cost');
      expect(names).toContain('confirm_cost');
    });

    test('lists cost tools for a modern client without elicitation', async () => {
      const { client } = await setupModern({});

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toContain('get_cost');
      expect(names).toContain('confirm_cost');
    });

    test('lists cost tools for a capability-free client', async () => {
      const { client } = await setup({
        elicitation: {
          requestState: ELICITATION_REQUEST_STATE,
          confirmation: COST_CONFIRMATION,
        },
      });

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toContain('get_cost');
      expect(names).toContain('confirm_cost');
    });

    test('capability-free client still succeeds via get_cost -> confirm_cost -> create_project', async () => {
      const { callTool } = await setup({
        elicitation: {
          requestState: ELICITATION_REQUEST_STATE,
          confirmation: COST_CONFIRMATION,
        },
      });

      const freeOrg = await createOrganization({
        name: 'Free Org',
        plan: 'free',
        allowed_release_channels: ['ga'],
      });

      const confirm_cost_id_result = await callTool({
        name: 'confirm_cost',
        arguments: { type: 'project', recurrence: 'monthly', amount: 0 },
      });

      const result = await callTool({
        name: 'create_project',
        arguments: {
          name: 'New Project',
          region: 'us-east-1',
          organization_id: freeOrg.id,
          confirm_cost_id: confirm_cost_id_result.confirmation_id,
        },
      });

      expect(result).toMatchObject({
        name: 'New Project',
        region: 'us-east-1',
        organization_id: freeOrg.id,
      });
      expect(mockProjects.size).toBe(1);
    });

    test('form-capable client: $0 creates without elicitation', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
      });

      const freeOrg = await createOrganization({
        name: 'Free Org',
        plan: 'free',
        allowed_release_channels: ['ga'],
      });

      const result = (await callModernTool(client, {
        name: 'create_project',
        arguments: {
          name: 'New Project',
          region: 'us-east-1',
          organization_id: freeOrg.id,
        },
      })) as CallToolResult | InputRequiredResult;

      expect(isInputRequiredResult(result)).toBe(false);
      if (isInputRequiredResult(result)) {
        throw new Error('expected a CallToolResult');
      }
      expect(result.isError).toBeFalsy();
      expect(mockProjects.size).toBe(1);
    });

    test('form-capable client: accept creates the project exactly once', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'accept',
      });
      const { org } = await createOrganizationWithBillableNextProject();

      const result = await client.callTool({
        name: 'create_project',
        arguments: {
          name: 'New Project',
          region: 'us-east-1',
          organization_id: org.id,
        },
      });

      expect(result.isError).toBeFalsy();
      const [content] = result.content;
      if (content?.type !== 'text') {
        throw new Error('expected text content');
      }
      const project = JSON.parse(content.text);
      expect(project).toMatchObject({
        name: 'New Project',
        region: 'us-east-1',
        organization_id: org.id,
      });
      expect(mockProjects.size).toBe(2);
    });

    test('form-capable client: decline does not create a project', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'decline',
      });
      const { org } = await createOrganizationWithBillableNextProject();

      const result = await client.callTool({
        name: 'create_project',
        arguments: {
          name: 'New Project',
          region: 'us-east-1',
          organization_id: org.id,
        },
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ status: 'declined' });
      expect(mockProjects.size).toBe(1);
    });

    test('form-capable client: cancel does not create a project', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'cancel',
      });
      const { org } = await createOrganizationWithBillableNextProject();

      const result = await client.callTool({
        name: 'create_project',
        arguments: {
          name: 'New Project',
          region: 'us-east-1',
          organization_id: org.id,
        },
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ status: 'cancelled' });
      expect(mockProjects.size).toBe(1);
    });

    test('rejects a retry whose arguments changed since the state was minted', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
      });
      const { org } = await createOrganizationWithBillableNextProject();
      const otherOrg = await createOrganization({
        name: 'Other Org',
        plan: 'free',
        allowed_release_channels: ['ga'],
      });

      const first = (await callModernTool(client, {
        name: 'create_project',
        arguments: {
          name: 'New Project',
          region: 'us-east-1',
          organization_id: org.id,
        },
      })) as CallToolResult | InputRequiredResult;

      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }

      const second = (await callModernTool(client, {
        name: 'create_project',
        arguments: {
          name: 'New Project',
          region: 'us-east-1',
          organization_id: otherOrg.id,
        },
        inputResponses: {
          confirm_cost: { action: 'accept', content: {} },
        },
        requestState: first.requestState,
      })) as CallToolResult | InputRequiredResult;

      if (isInputRequiredResult(second)) {
        throw new Error('expected a CallToolResult');
      }

      expect(second.isError).toBe(true);
      expect(second.structuredContent).toEqual({ status: 'error' });
      expect(mockProjects.size).toBe(1);
    });

    test('creates without re-prompting when the quoted cost drops to zero before confirmation', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
      });
      const { org, existingProject } =
        await createOrganizationWithBillableNextProject();

      const args = {
        name: 'New Project',
        region: 'us-east-1',
        organization_id: org.id,
      };

      const first = (await callModernTool(client, {
        name: 'create_project',
        arguments: args,
      })) as CallToolResult | InputRequiredResult;

      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }

      existingProject.status = 'INACTIVE';

      const second = (await callModernTool(client, {
        name: 'create_project',
        arguments: args,
        inputResponses: {
          confirm_cost: { action: 'accept', content: {} },
        },
        requestState: first.requestState,
      })) as CallToolResult | InputRequiredResult;

      expect(isInputRequiredResult(second)).toBe(false);
      if (isInputRequiredResult(second)) {
        throw new Error('expected a CallToolResult');
      }
      expect(second.isError).toBeFalsy();
      expect(mockProjects.size).toBe(2);
    });

    test('a decline is honored even when the quoted cost changed since the state was minted', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
      });
      const { org, existingProject } =
        await createOrganizationWithBillableNextProject();

      const args = {
        name: 'New Project',
        region: 'us-east-1',
        organization_id: org.id,
      };

      const first = (await callModernTool(client, {
        name: 'create_project',
        arguments: args,
      })) as CallToolResult | InputRequiredResult;

      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }

      existingProject.status = 'INACTIVE';

      const second = (await callModernTool(client, {
        name: 'create_project',
        arguments: args,
        inputResponses: {
          confirm_cost: { action: 'decline' },
        },
        requestState: first.requestState,
      })) as CallToolResult | InputRequiredResult;

      if (isInputRequiredResult(second)) {
        throw new Error('expected a CallToolResult');
      }

      expect(second.structuredContent).toEqual({ status: 'declined' });
      expect(mockProjects.size).toBe(1);
    });
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

  test('list notebooks', async () => {
    const { callTool } = await setup({ features: ['notebooks'] });

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

    project.createNotebook({ name: 'Notebook 1', favorite: true });
    project.createNotebook({
      name: 'Notebook 2',
      description: 'Second notebook',
    });

    const result = await callTool({
      name: 'list_notebooks',
      arguments: {
        project_id: project.id,
      },
    });

    expect(Array.isArray(result.notebooks)).toBe(true);
    expect(result.notebooks.length).toBe(2);
    expect(result.notebooks[0]).toEqual(
      expect.objectContaining({
        name: 'Notebook 1',
        description: null,
        favorite: true,
        inserted_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
    expect(result.notebooks[1]).toEqual(
      expect.objectContaining({
        name: 'Notebook 2',
        description: 'Second notebook',
        favorite: false,
      })
    );
    // list_notebooks omits cell content
    expect(result.notebooks[0].content).toBeUndefined();
  });

  test('get notebook', async () => {
    const { callTool } = await setup({ features: ['notebooks'] });

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

    const notebook = project.createNotebook({
      name: 'Notebook 1',
      content: {
        schema_version: 1,
        cells: [{ id: 'cell-1', type: 'markdown', text: 'Hello world' }],
      },
    });

    const result = await callTool({
      name: 'get_notebook',
      arguments: {
        project_id: project.id,
        notebook_id: notebook.id,
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: notebook.id,
        name: 'Notebook 1',
        content: {
          schema_version: 1,
          cells: [{ id: 'cell-1', type: 'markdown', text: 'Hello world' }],
        },
      })
    );
  });

  test('get notebook that does not exist throws an error', async () => {
    const { callTool } = await setup({ features: ['notebooks'] });

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
      name: 'get_notebook',
      arguments: {
        project_id: project.id,
        notebook_id: 'does-not-exist',
      },
    });

    await expect(result).rejects.toThrow('Notebook not found');
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
        remediation_sql:
          'ALTER TABLE "public"."test" ENABLE ROW LEVEL SECURITY;',
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
        'notebooks',
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
    // Registered only when secretCollection is configured; get_cost/confirm_cost hidden from form-capable clients
    const conditionallyHiddenToolNames = new Set([
      'get_logs',
      'create_edge_function_secret',
      'get_cost',
      'confirm_cost',
    ]);

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
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

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
        'notebooks',
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

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

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

  test('notebooks tools', async () => {
    const { client } = await setup({
      features: ['notebooks'],
    });

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(['list_notebooks', 'get_notebook']);
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

    const accountLevelToolNames = [
      'list_organizations',
      'get_organization',
      'list_projects',
      'get_project',
      'get_cost',
      'confirm_cost',
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
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

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
    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

    await project.db
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

    try {
      for (let i = 0; i < 9; i++) {
        const { client } = await setup();
        await client.listTools();
      }

      const registryAdditions = addSpy.mock.calls.length;
      expect(registryAdditions).toBe(0);
    } finally {
      addSpy.mockRestore();
    }
  });
});
