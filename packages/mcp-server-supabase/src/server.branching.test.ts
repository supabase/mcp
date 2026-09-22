import { isInputRequiredResult } from '@modelcontextprotocol/client';
import type {
  CallToolResult,
  ClientCapabilities,
  InputRequiredResult,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createBranch,
  createOrganization,
  createProject,
  createProjectFixture,
  mockBranches,
} from '../test/mocks.js';
import { callModernTool, createServerHarness } from '../test/server-harness.js';
import { BRANCH_COST_HOURLY, getBranchCost } from './pricing.js';
import * as pricing from './pricing.js';
import type { SupabaseMcpServerOptions } from './server.js';
import { hashObject } from './util.js';

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
  test('create branch', async () => {
    const { callTool } = await setup({
      features: ['account', 'branching'],
    });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

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

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

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

  test('delete branch', async () => {
    const { callTool } = await setup({
      features: ['account', 'branching'],
    });

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
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

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

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

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

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

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
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

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

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

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
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

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

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

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
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

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
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

    const { project } = await createProjectFixture({
      organization: { name: 'My Org', allowed_release_channels: ['ga'] },
      project: { name: 'Project 1', region: 'us-east-1' },
    });

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
