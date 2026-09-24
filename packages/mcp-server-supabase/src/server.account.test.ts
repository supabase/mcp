import { isInputRequiredResult } from '@modelcontextprotocol/client';
import type {
  CallToolResult,
  ClientCapabilities,
  InputRequiredResult,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createOrganization,
  createProject,
  mockProjects,
} from '../test/mocks.js';
import { callModernTool, createServerHarness } from '../test/server-harness.js';
import { BRANCH_COST_HOURLY, PROJECT_COST_MONTHLY } from './pricing.js';
import type { SupabaseMcpServerOptions } from './server.js';

const harness = createServerHarness();
const setup = harness.setup;
const setupModern = harness.setupModern;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

const ELICITATION_REQUEST_STATE: NonNullable<
  SupabaseMcpServerOptions['elicitation']
>['requestState'] = {
  key: 'a'.repeat(32),
  principal: 'test-user',
};

const COST_CONFIRMATION: NonNullable<
  NonNullable<SupabaseMcpServerOptions['elicitation']>['confirmation']
> = {
  enabledTools: [
    'create_project',
    'create_branch',
    'execute_sql',
    'apply_migration',
  ],
};

const FORM_CAPABLE: ClientCapabilities = { elicitation: { form: {} } };

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
});
