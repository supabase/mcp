import type { Branch } from '@supabase/mcp-server-supabase/platform';
import { callTool } from '../../shared/call-tool';
import { ProgressView, Summary } from '../../shared/ProgressView';
import { stepsAt } from '../../shared/StepStatus';
import { usePoll } from '../../shared/use-poll';
import { useMcpView } from '../../shared/use-mcp-view';
import { isTerminal, LABELS, progress } from './status';

/** View for the `create_branch` tool. */
export function CreateBranch() {
  const { toolCall, app, input, hostCapabilities } = useMcpView<Branch>(
    'supabase-create-branch'
  );
  const branch = toolCall.status === 'ready' ? toolCall.data : undefined;
  const canPoll = !!hostCapabilities.serverTools;
  const serverScoped = input !== undefined && input.project_id === undefined;

  const poll = usePoll<Branch>({
    enabled: !!app && !!branch && !!input && canPoll,
    fetcher: async () => {
      const { branches } = await callTool<{ branches: Branch[] }>(
        app!,
        'list_branches',
        serverScoped ? {} : { project_id: branch!.parent_project_ref }
      );
      const found = branches.find((b) => b.id === branch!.id);
      if (!found) throw new Error('Branch not found in list_branches');
      return found;
    },
    isTerminal: (b) => isTerminal(b.status),
  });

  return (
    <div className="create-branch-view">
      <ProgressView
        toolCall={toolCall}
        app={app}
        poll={poll}
        checkWith="list_branches"
        canPoll={canPoll}
        canOpenLinks={!!hostCapabilities.openLinks}
        waitingLabel="Waiting for confirmation…"
        input={input}
        noun="branch"
        titles={{
          creating: 'Creating branch',
          created: 'Created branch',
          failed: 'Creating branch failed',
          cancelled: 'Creating branch cancelled',
        }}
        inputSummary={({ name }) =>
          typeof name === 'string' ? (
            <Summary name={name} items={[]} />
          ) : undefined
        }
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
    </div>
  );
}
