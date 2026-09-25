import type { AccountOperations } from './platform/types.js';

export const PROJECT_COST_MONTHLY = 10;
export const BRANCH_COST_HOURLY = 0.01344;

export type ProjectCost = {
  type: 'project';
  recurrence: 'monthly';
  amount: number;
};

export type BranchCost = {
  type: 'branch';
  recurrence: 'hourly';
  amount: number;
};

export type Cost = ProjectCost | BranchCost;

/**
 * Gets the cost of the next project in an organization.
 */
export async function getNextProjectCost(
  account: AccountOperations,
  orgId: string
): Promise<Cost> {
  const org = await account.getOrganization(orgId);
  const projects = await account.listProjects();

  const activeProjects = projects.filter(
    (project) =>
      project.organization_id === orgId &&
      !['INACTIVE', 'GOING_DOWN', 'REMOVED'].includes(project.status)
  );

  let amount = 0;

  if (org.plan !== 'free') {
    // If the organization is on a paid plan, the first project is included
    if (activeProjects.length > 0) {
      amount = PROJECT_COST_MONTHLY;
    }
  }

  return { type: 'project', recurrence: 'monthly', amount };
}

/**
 * Gets the cost for a database branch.
 */
export function getBranchCost(): BranchCost {
  return { type: 'branch', recurrence: 'hourly', amount: BRANCH_COST_HOURLY };
}
