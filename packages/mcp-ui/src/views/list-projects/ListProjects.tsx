import { Message } from '../../shared/Message';
import { useToolResult } from '../../shared/use-tool-result';

export type Project = {
  id: string;
  ref: string;
  name: string;
  organization_slug: string;
  region: string;
  status: string;
  created_at: string;
};

/** View for the `list_projects` tool. */
export function ListProjects() {
  const state = useToolResult<{ projects: Project[] }>(
    'supabase-list-projects'
  );

  if (state.status === 'error') {
    return <Message tone="error">{state.message}</Message>;
  }
  if (state.status === 'cancelled') {
    return (
      <Message>Cancelled{state.reason ? ` (${state.reason})` : ''}.</Message>
    );
  }
  if (state.status === 'loading') return <Message>Loading projects…</Message>;
  if (state.data.projects.length === 0) {
    return <Message>No projects found.</Message>;
  }

  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr>
            <th className="heading-meta">Project</th>
            <th className="heading-meta">Status</th>
            <th className="heading-meta">Region</th>
            <th className="heading-meta numeric">Created</th>
          </tr>
        </thead>
        <tbody>
          {state.data.projects.map((project) => (
            <tr key={project.id}>
              <td>
                <div>{project.name}</div>
                <div className="mono text-lighter" style={{ fontSize: 12 }}>
                  {project.ref}
                </div>
              </td>
              <td>
                <StatusBadge status={project.status} />
              </td>
              <td className="mono text-muted" style={{ fontSize: 12 }}>
                {project.region}
              </td>
              <td className="numeric text-muted">
                {formatDate(project.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Management API project statuses, grouped the way the dashboard shows them:
 * healthy, paused, failed, or in progress.
 */
function StatusBadge({ status }: { status: string }) {
  if (status === 'ACTIVE_HEALTHY') {
    return <span className="badge badge-success">Healthy</span>;
  }
  if (status === 'INACTIVE') return <span className="badge">Paused</span>;
  if (status.endsWith('_FAILED') || status === 'REMOVED') {
    return <span className="badge badge-destructive">{label(status)}</span>;
  }
  return <span className="badge badge-warning">{label(status)}</span>;
}

/** `COMING_UP` → `Coming up`. */
function label(status: string) {
  const text = status.toLowerCase().replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
}
