import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createBranch, createProjectFixture } from '../test/mocks.js';
import { createServerHarness } from '../test/server-harness.js';
import { BRANCH_COST_HOURLY } from './pricing.js';

const harness = createServerHarness();
const setup = harness.setup;

beforeEach(() => harness.reset());
afterEach(() => harness.close());

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
});
