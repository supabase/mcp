import { callTool } from '../../shared/call-tool';
import { ProgressView, Summary } from '../../shared/ProgressView';
import { stepsAt } from '../../shared/StepStatus';
import { usePoll } from '../../shared/use-poll';
import { useMcpView } from '../../shared/use-mcp-view';

export type Project = {
  id: string;
  ref?: string;
  name: string;
  region: string;
  status: string;
  organization_id?: string;
  organization_slug?: string;
  created_at?: string;
};

const LABELS = ['Creating project', 'Provisioning', 'Running health checks'];

const isFailed = (status: string) =>
  status === 'REMOVED' || status.endsWith('_FAILED');

/** Index of the current step for a Management API project status. */
function currentStep(status: string) {
  if (status === 'ACTIVE_HEALTHY') return LABELS.length;
  if (status === 'COMING_UP' || status === 'UNKNOWN' || isFailed(status)) {
    return 1;
  }
  // Left COMING_UP but not healthy yet (e.g. ACTIVE_UNHEALTHY).
  return 2;
}

/** View for the `create_project` tool. */
export function CreateProject() {
  const { toolCall, app } = useMcpView<Project>('supabase-create-project');
  const project = toolCall.status === 'ready' ? toolCall.data : undefined;

  const poll = usePoll<Project>({
    enabled: !!app && !!project,
    fetcher: () => callTool<Project>(app!, 'get_project', { id: project!.id }),
    isTerminal: (p) => p.status === 'ACTIVE_HEALTHY' || isFailed(p.status),
  });

  return (
    <ProgressView
      toolCall={toolCall}
      app={app}
      poll={poll}
      checkWith="get_project"
      waitingLabel="Waiting for confirmation…"
      summary={(p) => (
        <Summary
          name={p.name}
          items={[
            { label: 'ref', value: p.ref ?? p.id },
            { label: 'region', value: p.region },
          ]}
        />
      )}
      steps={(p) => stepsAt(LABELS, currentStep(p.status), isFailed(p.status))}
      ready={(p) => p.status === 'ACTIVE_HEALTHY'}
      projectRef={(p) => p.ref ?? p.id}
    />
  );
}
