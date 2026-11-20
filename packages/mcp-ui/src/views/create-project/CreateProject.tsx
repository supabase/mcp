import type { Project } from '@supabase/mcp-server-supabase/platform';
import { callTool } from '../../shared/call-tool';
import { cardName, ProjectCard } from '../../shared/ProjectCard';
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
  const view = useMcpView<Project>('supabase-create-project');
  const { toolCall, app, canCallTools, openLink, inputText, dashboardUrl } =
    view;
  /** The project's page in the Supabase dashboard (Studio). */
  const studioUrl = (ref: string) =>
    `${dashboardUrl}/project/${encodeURIComponent(ref)}`;

  const {
    data: project,
    isLoading,
    isDone,
    card,
  } = useCreationStatus<Project>({
    config: creation,
    toolCall,
    read: canCallTools
      ? (created) => callTool<Project>(app!, 'get_project', { id: created.id })
      : undefined,
  });

  // The organization's name is a nicety: on failure the card leaves it out.
  const organization =
    project?.organization_slug ??
    project?.organization_id ??
    inputText('organization_id');
  const organizationName = useLookup(
    canCallTools ? organization : undefined,
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
  const canOpenDashboard = !!project && project.status !== 'REMOVED';

  const region = inputText('region');
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
    <ProjectCard
      {...card}
      breadcrumbs={organizationName ? [organizationName] : undefined}
      name={cardName({
        created: project?.name,
        requested: inputText('name'),
        isLoading,
        noun: 'project',
      })}
      details={details}
      onOpenDashboard={
        canOpenDashboard && openLink
          ? () => openLink(studioUrl(project.ref))
          : undefined
      }
    >
      {isDone && project && (
        <ConnectionDetails
          view={view}
          projectRef={project.ref}
          projectUrl={studioUrl(project.ref)}
          canReachProject={canCallTools}
        />
      )}
    </ProjectCard>
  );
}
