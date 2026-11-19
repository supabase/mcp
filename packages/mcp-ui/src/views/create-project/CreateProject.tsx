import type { Project } from '@supabase/mcp-server-supabase/platform';
import { callTool } from '../../shared/call-tool';
import { ProjectCard } from '../../shared/ProjectCard';
import { ConnectionDetails, studioUrl } from '../../shared/ConnectionDetails';
import { useCreationStatus } from '../../shared/use-creation-status';
import { useLookup } from '../../shared/use-lookup';
import { useMcpView } from '../../shared/use-mcp-view';
import { LABELS, progress } from './status';

const text = (value: unknown) =>
  typeof value === 'string' ? value : undefined;

/**
 * View for the `create_project` tool: the project card from the Supabase
 * surfaces, kept live. While the project sets up, the badge names the step
 * it's on (see `status.ts` for how steps map to statuses).
 */
export function CreateProject() {
  const { toolCall, app, input, hostCapabilities } = useMcpView<Project>(
    'supabase-create-project'
  );
  const canPoll = !!app && !!hostCapabilities.serverTools;
  const canOpenLinks = !!app && !!hostCapabilities.openLinks;

  const {
    data: project,
    isLoading,
    isDone,
    ...status
  } = useCreationStatus<Project>({
    noun: 'project',
    toolCall,
    canPollInitial: canPoll,
    read: (created) =>
      callTool<Project>(app!, 'get_project', { id: created.id }),
    labels: LABELS,
    progress,
    checkWith: 'get_project',
  });

  // The organization's name is a nicety: on failure the card leaves it out.
  const organization =
    project?.organization_slug ??
    project?.organization_id ??
    text(input?.organization_id);
  const organizationName = useLookup(
    canPoll ? organization : undefined,
    async () => {
      const { name } = await callTool<{ name: string }>(
        app!,
        'get_organization',
        { id: organization }
      );
      return name;
    }
  );

  // The dashboard has a project that failed to start (to delete it, or for
  // support), but nothing for one that was never created or was removed.
  const canOpenDashboard =
    !!project && canOpenLinks && project.status !== 'REMOVED';

  const region = text(input?.region);
  const details = project
    ? [
        { label: 'Project ref', value: project.ref },
        { label: 'Region', value: project.region || 'Region unavailable' },
      ]
    : isLoading
      ? [{ label: 'Project ref' }, { label: 'Region', value: region }]
      : region
        ? [{ label: 'Region', value: region }]
        : [];

  return (
    <div className="create-project-view">
      <ProjectCard
        {...status}
        isLoading={isLoading}
        breadcrumbs={organizationName ? [organizationName] : undefined}
        name={
          project?.name ??
          text(input?.name) ??
          // A call that failed or was cancelled before the host sent its
          // arguments: nothing more is coming, so no skeleton.
          (isLoading ? undefined : 'New project')
        }
        details={details}
        onOpenDashboard={
          canOpenDashboard
            ? () => void app!.openLink({ url: studioUrl(project.ref) })
            : undefined
        }
      >
        {isDone && project && app && (
          <ConnectionDetails
            app={app}
            projectRef={project.ref}
            canReachProject={canPoll}
            canOpenLinks={canOpenLinks}
          />
        )}
      </ProjectCard>
    </div>
  );
}
