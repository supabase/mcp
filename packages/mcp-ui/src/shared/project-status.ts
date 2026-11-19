/**
 * How a project's status reads in a badge, matching Studio's project list
 * (and the project card in the Supabase surfaces): healthy projects read as
 * Active, paused ones as Paused, and anything in progress or failed as a
 * warning.
 */
export type ProjectStatusBadge = {
  label: string;
  tone?: 'success' | 'warning';
};

const LABELS: Record<string, string> = {
  GOING_DOWN: 'Pausing',
  PAUSING: 'Pausing',
  PAUSE_FAILED: 'Pause failed',
  RESTARTING: 'Restarting',
  RESIZING: 'Resizing',
  RESTORING: 'Restoring',
  RESTORE_FAILED: 'Restore failed',
  UPGRADING: 'Upgrading',
  COMING_UP: 'Starting',
  UNKNOWN: 'Starting',
  INIT_FAILED: 'Setup failed',
  ACTIVE_UNHEALTHY: 'Unhealthy',
};

/** Statuses a project moves on from by itself, so the view keeps checking them. */
const CHANGING = new Set([
  'COMING_UP',
  'UNKNOWN',
  'GOING_DOWN',
  'PAUSING',
  'RESTARTING',
  'RESIZING',
  'RESTORING',
  'UPGRADING',
]);

/** Whether the project is still starting, pausing, restoring or otherwise changing state. */
export function isProjectChanging(status: string) {
  return CHANGING.has(status);
}

export function projectStatusBadge(status: string): ProjectStatusBadge {
  if (status === 'ACTIVE_HEALTHY') return { label: 'Active', tone: 'success' };
  if (status === 'INACTIVE') return { label: 'Paused' };
  const label = LABELS[status] ?? status.toLowerCase().replaceAll('_', ' ');
  return { label, tone: 'warning' };
}
