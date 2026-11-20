import {
  isProjectChanging,
  projectStatusBadge,
} from '../../shared/project-status';
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

  // A status a new project shouldn't reach (paused, restarting, …), with
  // Studio's label. Ones still in progress are neutral, like the steps.
  const { label, tone } = projectStatusBadge(status);
  const isChanging = isProjectChanging(status);
  return {
    state: 'other',
    label,
    tone: isChanging ? undefined : tone,
    isChanging,
  };
}

export const creation: CreationConfig<Project> = {
  noun: 'project',
  progress,
  checkWith: 'get_project',
};
