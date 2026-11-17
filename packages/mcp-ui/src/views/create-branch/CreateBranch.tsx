import { useState } from 'react';
import { callProjectTool } from '../../shared/call-tool';
import { ProgressView, Summary } from '../../shared/ProgressView';
import { stepsAt } from '../../shared/StepStatus';
import { usePoll } from '../../shared/use-poll';
import { useMcpView } from '../../shared/use-mcp-view';

export type Branch = {
  id: string;
  name: string;
  /** The branch's own project. */
  project_ref: string;
  parent_project_ref: string;
  status: string;
  is_default?: boolean;
  git_branch?: string;
  persistent?: boolean;
  created_at?: string;
  updated_at?: string;
};

const LABELS = [
  'Creating branch',
  'Creating project',
  'Running migrations',
  'Deploying functions',
];

/** Index of the current step and whether it failed, per branch status. */
function progress(status: string): { step: number; failed: boolean } {
  switch (status) {
    case 'FUNCTIONS_DEPLOYED':
      return { step: LABELS.length, failed: false };
    case 'MIGRATIONS_PASSED':
      return { step: 3, failed: false };
    case 'RUNNING_MIGRATIONS':
      return { step: 2, failed: false };
    case 'MIGRATIONS_FAILED':
      return { step: 2, failed: true };
    case 'FUNCTIONS_FAILED':
      return { step: 3, failed: true };
    default:
      // CREATING_PROJECT and anything unknown.
      return { step: 1, failed: false };
  }
}

const isTerminal = (status: string) =>
  status === 'FUNCTIONS_DEPLOYED' || progress(status).failed;

/** View for the `create_branch` tool. */
export function CreateBranch() {
  const { toolCall, app } = useMcpView<Branch>('supabase-create-branch');
  const branch = toolCall.status === 'ready' ? toolCall.data : undefined;
  // Whether the last poll found the server scoped (to the parent project).
  // Then no tool can target the branch's own project.
  const [serverScoped, setServerScoped] = useState(false);

  const poll = usePoll<Branch>({
    enabled: !!app && !!branch,
    fetcher: async () => {
      // `project_id` is the parent. It is not in the tool input in
      // project-scoped mode, so use the one from the result.
      // In scoped mode the server's project is the parent, so retrying
      // without `project_id` is correct here.
      const { branches } = await callProjectTool<{ branches: Branch[] }>(
        app!,
        'list_branches',
        branch!.parent_project_ref,
        {},
        { targetsScopedProject: true, onScope: setServerScoped }
      );
      const found = branches.find((b) => b.id === branch!.id);
      if (!found) throw new Error('Branch not found in list_branches');
      return found;
    },
    isTerminal: (b) => isTerminal(b.status),
  });

  return (
    <ProgressView
      toolCall={toolCall}
      app={app}
      poll={poll}
      checkWith="list_branches"
      waitingLabel="Waiting for confirmation…"
      summary={(b) => (
        <Summary
          name={b.name}
          items={[{ label: 'ref', value: b.project_ref }]}
        />
      )}
      steps={(b) => {
        const { step, failed } = progress(b.status);
        return stepsAt(LABELS, step, failed);
      }}
      ready={(b) => b.status === 'FUNCTIONS_DEPLOYED'}
      projectRef={(b) => b.project_ref}
      canReachProject={!serverScoped}
    />
  );
}
