import {
  createOrganization,
  createProject,
  mockBranches,
  mockProjects,
} from '../test/mocks.js';
import { callModernTool, createServerHarness } from '../test/server-harness.js';
import * as pricing from './pricing.js';
import { BRANCH_COST_HOURLY, getBranchCost } from './pricing.js';
import type { SupabaseMcpServerOptions } from './server.js';
import { hashObject } from './util.js';
import { isInputRequiredResult } from '@modelcontextprotocol/client';
import type {
  CallToolResult,
  ClientCapabilities,
  InputRequiredResult,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = createServerHarness();
const setup = harness.setup;

beforeEach(() => harness.reset());
afterEach(async () => {
  await harness.close();
});

const setupModern = harness.setupModern;

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

  describe('create_branch cost confirmation via elicitation', () => {
    test('create_branch requires confirm_cost_id when cost confirmation is not configured', async () => {
      const { client } = await setup({ features: ['branching'] });

      const { tools } = await client.listTools();
      const createBranchTool = tools.find(
        (tool) => tool.name === 'create_branch'
      );

      expect(createBranchTool?.inputSchema.required).toContain(
        'confirm_cost_id'
      );
    });

    test('create_branch advertises confirm_cost_id as optional when cost confirmation is configured', async () => {
      const { client } = await setup({
        features: ['branching'],
        elicitation: {
          requestState: ELICITATION_REQUEST_STATE,
          confirmation: COST_CONFIRMATION,
        },
      });

      const { tools } = await client.listTools();
      const createBranchTool = tools.find(
        (tool) => tool.name === 'create_branch'
      );

      expect(createBranchTool?.inputSchema.required).not.toContain(
        'confirm_cost_id'
      );
    });

    test('capability-free client still succeeds via get_cost -> confirm_cost -> create_branch', async () => {
      const { callTool } = await setup({
        features: ['account', 'branching'],
        elicitation: {
          requestState: ELICITATION_REQUEST_STATE,
          confirmation: COST_CONFIRMATION,
        },
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

      expect(result).toMatchObject({
        name: branchName,
        parent_project_ref: project.id,
      });
      // Creating a project's first branch also mints a same-named
      // `is_default` mock branch representing the parent project itself -
      // filter it out to count only the branch this call created.
      expect(
        Array.from(mockBranches.values()).filter(
          (branch) => branch.name === branchName && !branch.is_default
        )
      ).toHaveLength(1);
    });

    test('form-capable client: accept creates the branch exactly once', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'accept',
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

      const result = await client.callTool({
        name: 'create_branch',
        arguments: { project_id: project.id, name: 'test-branch' },
      });

      expect(result.isError).toBeFalsy();
      const [content] = result.content;
      if (content?.type !== 'text') {
        throw new Error('expected text content');
      }
      const branch = JSON.parse(content.text);
      expect(branch).toMatchObject({
        name: 'test-branch',
        parent_project_ref: project.id,
      });
      expect(
        Array.from(mockBranches.values()).filter(
          (branch) => branch.name === 'test-branch' && !branch.is_default
        )
      ).toHaveLength(1);
    });

    test('form-capable client: decline does not create a branch', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'decline',
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

      const result = await client.callTool({
        name: 'create_branch',
        arguments: { project_id: project.id, name: 'test-branch' },
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ status: 'declined' });
      expect(mockBranches.size).toBe(0);
    });

    test('form-capable client: cancel does not create a branch', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        elicitationAction: 'cancel',
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

      const result = await client.callTool({
        name: 'create_branch',
        arguments: { project_id: project.id, name: 'test-branch' },
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ status: 'cancelled' });
      expect(mockBranches.size).toBe(0);
    });

    test('form-capable client: a non-elicitation response re-prompts without creating a branch', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
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

      const args = { project_id: project.id, name: 'test-branch' };
      const first = (await callModernTool(client, {
        name: 'create_branch',
        arguments: args,
      })) as CallToolResult | InputRequiredResult;

      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }

      const second = (await callModernTool(client, {
        name: 'create_branch',
        arguments: args,
        inputResponses: {
          confirm_cost: { roots: [] },
        },
        requestState: first.requestState,
      })) as CallToolResult | InputRequiredResult;

      expect(isInputRequiredResult(second)).toBe(true);
      expect(mockBranches.size).toBe(0);
    });

    test('a decline is honored even when the quoted branch cost changed since the state was minted', async () => {
      const getBranchCostSpy = vi
        .spyOn(pricing, 'getBranchCost')
        .mockReturnValueOnce({
          type: 'branch',
          recurrence: 'hourly',
          amount: BRANCH_COST_HOURLY,
        })
        .mockReturnValueOnce({
          type: 'branch',
          recurrence: 'hourly',
          amount: BRANCH_COST_HOURLY + 1,
        });
      try {
        const { client } = await setupModern({
          clientCapabilities: FORM_CAPABLE,
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

        const args = { project_id: project.id, name: 'test-branch' };
        const first = (await callModernTool(client, {
          name: 'create_branch',
          arguments: args,
        })) as CallToolResult | InputRequiredResult;

        if (!isInputRequiredResult(first)) {
          throw new Error('expected an input_required result');
        }
        expect(first.inputRequests?.confirm_cost).toMatchObject({
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: expect.stringContaining(`$${BRANCH_COST_HOURLY}/hr`),
          },
        });
        expect(first.inputRequests?.confirm_cost).toMatchObject({
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: expect.stringContaining(
              'Standard rate, before plan allowances or exemptions.'
            ),
          },
        });
        expect(first.inputRequests?.confirm_cost).toMatchObject({
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: expect.stringContaining(
              'until deleted (~$9.68 per 30 days).'
            ),
          },
        });

        const second = (await callModernTool(client, {
          name: 'create_branch',
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
        expect(mockBranches.size).toBe(0);
      } finally {
        getBranchCostSpy.mockRestore();
      }
    });

    test('form-capable client: a supplied confirm_cost_id is rejected', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
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

      // The correct legacy hash. The field is not part of this client's
      // schema, so even a valid confirmation ID must not reach creation.
      const legacyConfirmCostId = await hashObject(getBranchCost());

      const result = (await callModernTool(client, {
        name: 'create_branch',
        arguments: {
          project_id: project.id,
          name: 'test-branch',
          confirm_cost_id: legacyConfirmCostId,
        },
      })) as CallToolResult | InputRequiredResult;

      if (isInputRequiredResult(result)) {
        throw new Error('expected a tool error, not an input_required result');
      }
      expect(result.isError).toBe(true);
      expect(mockBranches.size).toBe(0);
    });

    test('rejects a retry whose arguments changed since the state was minted', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
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

      const first = (await callModernTool(client, {
        name: 'create_branch',
        arguments: { project_id: project.id, name: 'test-branch' },
      })) as CallToolResult | InputRequiredResult;

      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }

      const second = (await callModernTool(client, {
        name: 'create_branch',
        arguments: { project_id: project.id, name: 'renamed-branch' },
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
      expect(mockBranches.size).toBe(0);
    });

    test('project-scoped server signs and uses the configured project', async () => {
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

      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
        projectId: project.id,
        elicitationAction: 'accept',
      });

      const { tools } = await client.listTools();
      const createBranchTool = tools.find(
        (tool) => tool.name === 'create_branch'
      );
      expect(
        Object.keys(createBranchTool?.inputSchema.properties ?? {})
      ).not.toContain('project_id');

      const result = await client.callTool({
        name: 'create_branch',
        arguments: { name: 'test-branch' },
      });

      expect(result.isError).toBeFalsy();
      const [content] = result.content;
      if (content?.type !== 'text') {
        throw new Error('expected text content');
      }
      const branch = JSON.parse(content.text);
      expect(branch).toMatchObject({
        name: 'test-branch',
        parent_project_ref: project.id,
      });
      expect(
        Array.from(mockBranches.values()).filter(
          (branch) => branch.name === 'test-branch' && !branch.is_default
        )
      ).toHaveLength(1);
    });

    test('rejects a requestState minted by create_project', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
      });

      // create_project only triggers cost confirmation for a paid org's
      // additional projects, so set up a pro org with one existing project.
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

      const projectFirst = (await callModernTool(client, {
        name: 'create_project',
        arguments: {
          organization_id: org.id,
          name: 'My Project',
          region: 'us-east-1',
        },
      })) as CallToolResult | InputRequiredResult;

      if (!isInputRequiredResult(projectFirst)) {
        throw new Error(
          'expected an input_required result from create_project'
        );
      }

      const result = (await callModernTool(client, {
        name: 'create_branch',
        arguments: { project_id: existingProject.id, name: 'test-branch' },
        inputResponses: {
          confirm_cost: { action: 'accept', content: {} },
        },
        requestState: projectFirst.requestState,
      })) as CallToolResult | InputRequiredResult;

      if (isInputRequiredResult(result)) {
        throw new Error('expected a CallToolResult');
      }

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ status: 'error' });
      expect(
        result.content.some(
          (c) =>
            c.type === 'text' &&
            c.text === 'Request state was not issued for create_branch.'
        )
      ).toBe(true);
      expect(mockBranches.size).toBe(0);
    });

    test('rejects a tampered requestState before the handler runs', async () => {
      const { client } = await setupModern({
        clientCapabilities: FORM_CAPABLE,
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

      const first = (await callModernTool(client, {
        name: 'create_branch',
        arguments: { project_id: project.id, name: 'test-branch' },
      })) as CallToolResult | InputRequiredResult;

      if (!isInputRequiredResult(first)) {
        throw new Error('expected an input_required result');
      }

      // Change significant bits in the final base64url character; changing only
      // padding bits can leave the decoded HMAC signature unchanged.
      const originalState = first.requestState as string;
      const lastChar = originalState.slice(-1);
      const tamperedState =
        originalState.slice(0, -1) + (lastChar === 'A' ? 'E' : 'A');

      await expect(
        callModernTool(client, {
          name: 'create_branch',
          arguments: { project_id: project.id, name: 'test-branch' },
          inputResponses: {
            confirm_cost: { action: 'accept', content: {} },
          },
          requestState: tamperedState,
        })
      ).rejects.toMatchObject({
        code: -32602,
        message: 'Invalid or expired requestState',
      });
      expect(mockBranches.size).toBe(0);
    });
  });
});
