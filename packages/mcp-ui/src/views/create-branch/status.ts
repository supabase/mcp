import type { Branch } from '@supabase/mcp-server-supabase/platform';
import type {
  CreationConfig,
  Progress,
} from '../../shared/use-creation-status';

/**
 * The steps of creating a branch. The first is the create call itself, done
 * by the time the view has a branch.
 */
const LABELS = [
  'Creating branch',
  'Creating',
  'Running migrations',
  'Deploying functions',
];

/** Where a new branch is, per branch status. */
export function progress(status: Branch['status']): Progress {
  switch (status) {
    case 'FUNCTIONS_DEPLOYED':
      return { state: 'done' };
    case 'MIGRATIONS_PASSED':
      return { state: 'step', step: 3 };
    case 'RUNNING_MIGRATIONS':
      return { state: 'step', step: 2 };
    case 'MIGRATIONS_FAILED':
      return { state: 'failed', step: 2 };
    case 'FUNCTIONS_FAILED':
      return { state: 'failed', step: 3 };
    default:
      // CREATING_PROJECT (provisioning the branch's database), and anything
      // newer than this view.
      return { state: 'step', step: 1 };
  }
}

export const creation: CreationConfig<Branch> = {
  noun: 'branch',
  labels: LABELS,
  progress,
  checkWith: 'list_branches',
};
