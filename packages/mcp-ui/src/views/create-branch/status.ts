import type { Branch } from '@supabase/mcp-server-supabase/platform';

export const LABELS = [
  'Creating branch',
  'Provisioning branch database',
  'Running migrations',
  'Deploying functions',
];

/** Index of the current step and whether it failed, per branch status. */
export function progress(status: Branch['status']): {
  step: number;
  failed: boolean;
} {
  switch (status) {
    case 'FUNCTIONS_DEPLOYED':
      return { step: LABELS.length, failed: false };
    case 'MIGRATIONS_PASSED':
      return { step: 3, failed: false };
    case 'RUNNING_MIGRATIONS':
      return { step: 2, failed: false };
    case 'MIGRATIONS_FAILED':
      return { step: 2, failed: true };
    case 'FUNCTIONS_FAILED':
      return { step: 3, failed: true };
    default:
      // CREATING_PROJECT (provisioning the branch's database), and anything
      // newer than this view.
      return { step: 1, failed: false };
  }
}

export const isTerminal = (status: Branch['status']) =>
  status === 'FUNCTIONS_DEPLOYED' || progress(status).failed;
