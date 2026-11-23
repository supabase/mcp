import type { Branch } from '@supabase/mcp-server-supabase/platform';
import type {
  CreationConfig,
  Progress,
} from '../../shared/use-creation-status';

/**
 * The steps of creating a branch: the create call itself, done by the time
 * the view has a branch, then creating the branch's project, running
 * migrations and deploying functions.
 */
const STEP_COUNT = 4;

/** On step `n` of creating a branch, the create call being step 1. */
const step = (label: string, n: number): Progress => ({
  state: 'step',
  label,
  step: n,
  of: STEP_COUNT,
});

/** Where a new branch is, per branch status. */
export function progress(status: Branch['status']): Progress {
  switch (status) {
    case 'FUNCTIONS_DEPLOYED':
      return { state: 'done' };
    case 'MIGRATIONS_PASSED':
      return step('Deploying functions', 4);
    case 'RUNNING_MIGRATIONS':
      return step('Running migrations', 3);
    case 'MIGRATIONS_FAILED':
      return { state: 'failed', during: 'Running migrations' };
    case 'FUNCTIONS_FAILED':
      return { state: 'failed', during: 'Deploying functions' };
    default:
      // CREATING_PROJECT (provisioning the branch's database), and anything
      // newer than this view.
      return step('Creating', 2);
  }
}

export const creation: CreationConfig<Branch> = {
  noun: 'branch',
  progress,
  checkWith: 'list_branches',
};
