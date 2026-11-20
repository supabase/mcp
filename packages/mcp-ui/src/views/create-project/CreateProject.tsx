import type { Project } from '@supabase/mcp-server-supabase/platform';
import { ProjectCard } from '../../shared/ProjectCard';
import { ConnectionDetails } from '../../shared/ConnectionDetails';
import { useCreationStatus } from '../../shared/use-creation-status';
import { useLookup } from '../../shared/use-lookup';
import { useMcpView } from '../../shared/use-mcp-view';
import { creation } from './status';

/**
 * View for the `create_project` tool: the project card from the Supabase
 * surfaces, kept live. While the project sets up, the badge names the step
 * it's on (see `status.ts` for how steps map to statuses).
 */
export function CreateProject() {
  const { toolCall, callTool, openLink, inputText, dashboardUrl } =
    useMcpView<Project>('supabase-create-project');
  /** The project's page in the Supabase dashboard (Studio). */
  const studioUrl = (ref: string) =>
    `${dashboardUrl}/project/${encodeURIComponent(ref)}`;

  const {
    data: project,
    isDone,
    card,
  } = useCreationStatus<Project>({
    config: creation,
    toolCall,
    read:
      callTool &&
      ((created) => callTool<Project>('get_project', { id: created.id })),
  });

  // The organization's name is a nicety: on failure the card leaves it out.
  const organization =
    project?.organization_slug ??
    project?.organization_id ??
    inputText('organization_id');
  const organizationName = useLookup(
    callTool ? organization : undefined,
    async () => {
      if (!callTool) return undefined;
      const { name } = await callTool<{ name: string }>('get_organization', {
        id: organization,
      });
      return name;
    }
  );

  // The dashboard has a project that failed to start (to delete it, or for
  // support), but nothing for one that was never created or was removed.
  const canOpenDashboard = !!project && project.status !== 'REMOVED';

  const region = inputText('region');

  return (
    <ProjectCard
      {...card}
      breadcrumbs={organizationName ? [organizationName] : undefined}
      name={project?.name ?? inputText('name')}
      details={[
        { label: 'Project ref', value: project?.ref },
        {
          label: 'Region',
          value: project ? project.region || 'Region unavailable' : region,
        },
      ]}
      onOpenDashboard={
        canOpenDashboard && openLink
          ? () => openLink(studioUrl(project.ref))
          : undefined
      }
    >
      {isDone && project && (
        <ConnectionDetails
          callTool={callTool}
          openLink={openLink}
          projectRef={project.ref}
          projectUrl={studioUrl(project.ref)}
        />
      )}
    </ProjectCard>
  );
}
