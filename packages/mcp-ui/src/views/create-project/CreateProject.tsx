import type { Project } from '@supabase/mcp-server-supabase/platform';
import { callTool } from '../../shared/call-tool';
import { ProgressView, Summary } from '../../shared/ProgressView';
import { stepsAt } from '../../shared/StepStatus';
import { usePoll } from '../../shared/use-poll';
import { useMcpView } from '../../shared/use-mcp-view';
import { currentStep, isFailed, LABELS } from './status';

/** View for the `create_project` tool. */
export function CreateProject() {
  const { toolCall, app, input, hostCapabilities } = useMcpView<Project>(
    'supabase-create-project'
  );
  const project = toolCall.status === 'ready' ? toolCall.data : undefined;
  const canPoll = !!hostCapabilities.serverTools;

  const poll = usePoll<Project>({
    enabled: !!app && !!project && canPoll,
    fetcher: () => callTool<Project>(app!, 'get_project', { id: project!.id }),
    isTerminal: (p) => p.status === 'ACTIVE_HEALTHY' || isFailed(p.status),
  });

  return (
    <div className="create-project-view">
      <ProgressView
        toolCall={toolCall}
        app={app}
        poll={poll}
        checkWith="get_project"
        canPoll={canPoll}
        canOpenLinks={!!hostCapabilities.openLinks}
        waitingLabel="Waiting for confirmation…"
        input={input}
        noun="project"
        titles={{
          creating: 'Creating project',
          created: 'Created project',
          failed: 'Creating project failed',
          cancelled: 'Creating project cancelled',
        }}
        inputSummary={({ name, region }) =>
          typeof name === 'string' && typeof region === 'string' ? (
            <Summary name={name} items={[{ label: 'region', value: region }]} />
          ) : undefined
        }
        summary={(p) => (
          <Summary
            name={p.name}
            items={[
              { label: 'ref', value: p.ref },
              { label: 'region', value: p.region },
            ]}
          />
        )}
        steps={(p) =>
          stepsAt(LABELS, currentStep(p.status), isFailed(p.status))
        }
        ready={(p) => p.status === 'ACTIVE_HEALTHY'}
        projectRef={(p) => p.ref}
      />
    </div>
  );
}
