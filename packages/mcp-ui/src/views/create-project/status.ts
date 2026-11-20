import type { Project } from '@supabase/mcp-server-supabase/platform';
import type {
  CreationConfig,
  Progress,
} from '../../shared/use-creation-status';

/**
 * The steps of creating a project. The Management API reports only the
 * project's status, so the step is inferred from it (see `progress`). The
 * create call itself counts as the first step, done by the time the view has
 * a project, so the steps it can show are the later ones.
 */
const STEP_COUNT = 3;

/** On step `n` of creating a project, the create call being step 1. */
const step = (label: string, n: number): Progress => ({
  state: 'step',
  label,
  step: n,
  of: STEP_COUNT,
});

/**
 * Statuses a new project shouldn't reach but that aren't failures, with the
 * labels of Studio's project list. Ones that move on by themselves are
 * `isChanging`, so the view keeps checking them.
 */
const OTHER: Record<string, { label: string; isChanging: boolean }> = {
  INACTIVE: { label: 'Paused', isChanging: false },
  GOING_DOWN: { label: 'Pausing', isChanging: true },
  PAUSING: { label: 'Pausing', isChanging: true },
  RESTARTING: { label: 'Restarting', isChanging: true },
  RESIZING: { label: 'Resizing', isChanging: true },
  RESTORING: { label: 'Restoring', isChanging: true },
  UPGRADING: { label: 'Upgrading', isChanging: true },
};

const isFailed = (status: string) =>
  status === 'REMOVED' || status.endsWith('_FAILED');

/** Where a new project is, for a Management API project status. */
export function progress(status: string): Progress {
  if (status === 'ACTIVE_HEALTHY') return { state: 'done' };
  // The API doesn't say which step failed.
  if (isFailed(status)) return { state: 'failed', during: 'Creating' };
  if (status === 'COMING_UP' || status === 'UNKNOWN') {
    return step('Creating', 2);
  }
  // Left COMING_UP but not healthy yet.
  if (status === 'ACTIVE_UNHEALTHY') return step('Checking health', 3);

  // A status a new project shouldn't reach (paused, restarting, …): one
  // Studio names is neutral, and any other is a warning.
  const known = OTHER[status];
  if (known) return { state: 'other', ...known };
  return {
    state: 'other',
    label: status.toLowerCase().replaceAll('_', ' '),
    tone: 'warning',
    isChanging: false,
  };
}

export const creation: CreationConfig<Project> = {
  noun: 'project',
  progress,
  checkWith: 'get_project',
};
