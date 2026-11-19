import {
  isProjectChanging,
  projectStatusBadge,
} from '../../shared/project-status';
import type { Progress } from '../../shared/use-creation-status';

/**
 * The steps of creating a project. The Management API reports only the
 * project's status, so the step is inferred from it (see `progress`). The
 * first is the create call itself, done by the time the view has a project.
 */
export const LABELS = ['Creating project', 'Creating', 'Checking health'];

const isFailed = (status: string) =>
  status === 'REMOVED' || status.endsWith('_FAILED');

/** Where a new project is, for a Management API project status. */
export function progress(status: string): Progress {
  if (status === 'ACTIVE_HEALTHY') return { state: 'done' };
  // The API doesn't say which step failed.
  if (isFailed(status)) return { state: 'failed', step: 1 };
  if (status === 'COMING_UP' || status === 'UNKNOWN') {
    return { state: 'step', step: 1 };
  }
  // Left COMING_UP but not healthy yet.
  if (status === 'ACTIVE_UNHEALTHY') return { state: 'step', step: 2 };

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
