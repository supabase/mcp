import type { App } from '@modelcontextprotocol/ext-apps';
import type { ReactNode } from 'react';
import { Message } from './Message';
import type { PollState } from './use-poll';
import { ReadyActions } from './ReadyActions';
import { useAnnouncement } from './Announcer';
import { type Step, StepBadge, StepLine, stepAnnouncement } from './StepStatus';
import type { ToolCallState } from './use-mcp-view';

/**
 * Shared shell for views that follow a long-running operation: waiting,
 * cancelled and error states, a summary, the step list, polling problems and,
 * once ready, the post-ready actions.
 */
export function ProgressView<T>({
  toolCall,
  app,
  waitingLabel,
  summary,
  steps,
  ready,
  projectRef,
  poll,
  checkWith,
  canReachProject,
}: {
  toolCall: ToolCallState<T>;
  app: App | null;
  waitingLabel: string;
  /**
   * Renders names and identifiers. This and the callbacks below receive the
   * latest known data: the newest polled result, or the tool result until the
   * first poll returns.
   */
  summary: (data: T) => ReactNode;
  steps: (data: T) => Step[];
  ready: (data: T) => boolean;
  /** The project the ready actions operate on. */
  projectRef: (data: T) => string;
  /** Polls for the same type the tool returned. */
  poll: PollState<T>;
  /** Tool the model can use to check progress, shown if polling stops. */
  checkWith: string;
  /** See `ReadyActions`. */
  canReachProject?: boolean;
}) {
  const view = progressBody({
    toolCall,
    app,
    waitingLabel,
    summary,
    steps,
    ready,
    projectRef,
    poll,
    checkWith,
    canReachProject,
  });

  useAnnouncement(view.announce.polite);
  useAnnouncement(view.announce.assertive, 'assertive');

  return view.content;
}

function progressBody<T>({
  toolCall,
  app,
  waitingLabel,
  summary,
  steps,
  ready,
  projectRef,
  poll,
  checkWith,
  canReachProject,
}: Parameters<typeof ProgressView<T>>[0]): {
  content: ReactNode;
  announce: { polite?: string; assertive?: string };
} {
  if (toolCall.status === 'error') {
    return {
      content: <Message tone="error">{toolCall.message}</Message>,
      announce: { assertive: toolCall.message },
    };
  }
  if (toolCall.status === 'cancelled') {
    const text = `Cancelled${toolCall.reason ? ` (${toolCall.reason})` : ''}.`;
    return { content: <Message>{text}</Message>, announce: { polite: text } };
  }
  if (toolCall.status === 'loading') {
    return {
      content: <Message>{waitingLabel}</Message>,
      announce: { polite: waitingLabel },
    };
  }

  const data = poll.data ?? toolCall.data;
  const isReady = ready(data);
  const stepList = steps(data);
  const pollError =
    !isReady && poll.status === 'error'
      ? `Can't check progress: ${poll.error.message}. Ask the assistant to check with ${checkWith}.`
      : undefined;
  const timedOut = !isReady && poll.status === 'timeout';

  const announce = stepAnnouncement(stepList);
  if (timedOut) announce.polite = 'Timed out.';
  if (pollError) announce.assertive = pollError;

  return {
    announce,
    content: (
      <div className="card card-body stack">
        <div className="card-header">
          {summary(data)}
          <StepBadge steps={stepList} timedOut={timedOut} />
        </div>
        <StepLine steps={stepList} running={poll.status === 'running'} />
        {timedOut && (
          <div className="row">
            <Message>Timed out.</Message>
            <button type="button" className="btn" onClick={poll.retry}>
              Retry
            </button>
          </div>
        )}
        {pollError && (
          <div className="row">
            <Message tone="error">{pollError}</Message>
            <button type="button" className="btn" onClick={poll.retry}>
              Retry
            </button>
          </div>
        )}
        {isReady && app && (
          <ReadyActions
            app={app}
            projectRef={projectRef(data)}
            canReachProject={canReachProject}
          />
        )}
      </div>
    ),
  };
}

/** Name, identifier and extra facts, e.g. region. */
export function Summary({
  name,
  items,
}: {
  name: string;
  items: { label: string; value: string }[];
}) {
  return (
    <div>
      <div className="font-medium">{name}</div>
      <div className="row text-lighter mono text-small">
        {items.map((item) => (
          <span key={item.label}>
            {item.label}: {item.value}
          </span>
        ))}
      </div>
    </div>
  );
}
