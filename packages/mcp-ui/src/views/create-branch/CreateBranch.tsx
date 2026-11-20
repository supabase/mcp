import type { Branch, Project } from '@supabase/mcp-server-supabase/platform';
import { cardName, ProjectCard } from '../../shared/ProjectCard';
import { ConnectionDetails } from '../../shared/ConnectionDetails';
import { useCreationStatus } from '../../shared/use-creation-status';
import { useLookup } from '../../shared/use-lookup';
import { useMcpView } from '../../shared/use-mcp-view';
import { creation } from './status';

/**
 * View for the `create_branch` tool: the same card as `create_project`, kept
 * live, with the branch's organization and project above its name. While the
 * branch sets up, the badge names the step it's on (see `status.ts`).
 */
export function CreateBranch() {
  const { toolCall, input, callTool, openLink, inputText, dashboardUrl } =
    useMcpView<Branch>('supabase-create-branch');
  /** The branch's page in the Supabase dashboard (Studio). */
  const studioUrl = (ref: string) =>
    `${dashboardUrl}/project/${encodeURIComponent(ref)}`;
  // A server scoped to the parent project takes no `project_id`, and rejects
  // calls for any other project, the branch's own included.
  const serverScoped = input !== undefined && input.project_id === undefined;
  const projectTools = serverScoped ? undefined : callTool;

  const {
    data: branch,
    isLoading,
    isDone,
    card,
  } = useCreationStatus<Branch>({
    config: creation,
    toolCall,
    // Reading the branch depends on the arguments (whether the server is scoped).
    read:
      callTool && input
        ? async (created) => {
            const { branches } = await callTool<{ branches: Branch[] }>(
              'list_branches',
              serverScoped ? {} : { project_id: created.parent_project_ref }
            );
            const found = branches.find((b) => b.id === created.id);
            if (!found) throw new Error('Branch not found in list_branches');
            return found;
          }
        : undefined,
  });

  // Organization and project names are a nicety: if they can't be read, the
  // card leaves them out. A scoped server has no `get_project`, so it isn't
  // asked: the call would only fail, and count as a tool error.
  const parentRef = branch?.parent_project_ref ?? inputText('project_id');
  const breadcrumbs = useLookup(
    projectTools ? parentRef : undefined,
    async () => {
      if (!projectTools) return undefined;
      const parent = await projectTools<Project>('get_project', {
        id: parentRef,
      });
      const organization = await projectTools<{ name: string }>(
        'get_organization',
        { id: parent.organization_slug ?? parent.organization_id }
      ).catch(() => undefined);
      return organization ? [organization.name, parent.name] : [parent.name];
    }
  );

  return (
    <ProjectCard
      {...card}
      breadcrumbs={breadcrumbs}
      name={cardName({
        created: branch?.name,
        requested: inputText('name'),
        isLoading,
        noun: 'branch',
      })}
      details={
        branch
          ? [{ label: 'Branch project ref', value: branch.project_ref }]
          : isLoading
            ? [{ label: 'Branch project ref' }]
            : []
      }
      onOpenDashboard={
        branch && openLink
          ? () => openLink(studioUrl(branch.project_ref))
          : undefined
      }
    >
      {isDone && branch && (
        <ConnectionDetails
          callTool={projectTools}
          openLink={openLink}
          projectRef={branch.project_ref}
          projectUrl={studioUrl(branch.project_ref)}
        />
      )}
    </ProjectCard>
  );
}
