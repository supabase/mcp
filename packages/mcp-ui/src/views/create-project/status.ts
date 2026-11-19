export const LABELS = [
  'Creating project',
  'Provisioning',
  'Running health checks',
];

export const isFailed = (status: string) =>
  status === 'REMOVED' || status.endsWith('_FAILED');

/** Index of the current step for a Management API project status. */
export function currentStep(status: string) {
  if (status === 'ACTIVE_HEALTHY') return LABELS.length;
  if (status === 'COMING_UP' || status === 'UNKNOWN' || isFailed(status)) {
    return 1;
  }
  // Left COMING_UP but not healthy yet (e.g. ACTIVE_UNHEALTHY). Statuses a
  // new project shouldn't reach (INACTIVE, PAUSING, RESTARTING, …) also land
  // here and poll until the timeout; fine for the proof of concept.
  return 2;
}
