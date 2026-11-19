import type { App } from '@modelcontextprotocol/ext-apps';
import type { ReactNode } from 'react';
import { Badge } from './Badge';
import type { PollState } from './use-poll';
import { ReadyActions } from './ReadyActions';
import { useAnnouncement } from './Announcer';
import { SpinnerIcon, XCircleIcon } from './icons';
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
  input,
  noun,
  titles,
  inputSummary,
  summary,
  steps,
  ready,
  projectRef,
  poll,
  checkWith,
  canPoll = true,
  canReachProject,
  canOpenLinks,
}: {
  toolCall: ToolCallState<T>;
  app: App | null;
  waitingLabel: string;
  /** The tool call's arguments, once received. */
  input?: Record<string, unknown>;
  /** What is being created, for messages: "project" or "branch". */
  noun: string;
  /**
   * Card heading per state: `created` once ready, `failed` when a step
   * failed or the tool call returned an error, `cancelled` when the call was
   * cancelled, otherwise `creating` (including timed out and poll errors,
   * where the outcome is unknown).
   */
  titles: {
    creating: string;
    created: string;
    failed: string;
    cancelled: string;
  };
  /**
   * Summary for the cards shown when the tool call failed or was cancelled,
   * built from its arguments. Return nothing if they lack what it needs.
   */
  inputSummary: (input: Record<string, unknown>) => ReactNode;
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
  /**
   * False when the host can't proxy tool calls (no `serverTools`), so there
   * is no polling: the view says to ask the assistant instead.
   */
  canPoll?: boolean;
  /** See `ReadyActions`. */
  canReachProject?: boolean;
  /** See `ReadyActions`. */
  canOpenLinks?: boolean;
}) {
  const view = progressBody({
    toolCall,
    app,
    waitingLabel,
    input,
    noun,
    titles,
    inputSummary,
    summary,
    steps,
    ready,
    projectRef,
    poll,
    checkWith,
    canPoll,
    canReachProject,
    canOpenLinks,
  });

  useAnnouncement(view.announce.polite);
  useAnnouncement(view.announce.assertive, 'assertive');

  return view.content;
}

function progressBody<T>({
  toolCall,
  app,
  waitingLabel,
  input,
  noun,
  titles,
  inputSummary,
  summary,
  steps,
  ready,
  projectRef,
  poll,
  checkWith,
  canPoll = true,
  canReachProject,
  canOpenLinks,
}: Parameters<typeof ProgressView<T>>[0]): {
  content: ReactNode;
  announce: { polite?: string; assertive?: string };
} {
  if (toolCall.status === 'error') {
    return {
      content: (
        <div className="progress-card">
          <CardHeader
            title={titles.failed}
            badge={<Badge tone="danger">Failed</Badge>}
          >
            {input && inputSummary(input)}
          </CardHeader>
          <div data-slot="problem" data-tone="danger">
            <XCircleIcon />
            <span>{toolCall.message}</span>
          </div>
        </div>
      ),
      announce: { assertive: `${titles.failed}: ${toolCall.message}` },
    };
  }
  if (toolCall.status === 'cancelled') {
    const { reason } = toolCall;
    return {
      content: (
        <div className="progress-card">
          <CardHeader title={titles.cancelled} badge={<Badge>Cancelled</Badge>}>
            {input && inputSummary(input)}
          </CardHeader>
          {reason && (
            <div data-slot="problem" data-tone="muted">
              <span>{reason}</span>
            </div>
          )}
        </div>
      ),
      announce: {
        polite: reason ? `Cancelled: ${reason}` : 'Cancelled',
      },
    };
  }
  if (toolCall.status === 'loading') {
    return {
      content: (
        <div className="progress-card">
          <CardHeader title={titles.creating}>
            {input && inputSummary(input)}
          </CardHeader>
          <div data-slot="step" data-state="active">
            <SpinnerIcon />
            <span>{waitingLabel}</span>
          </div>
        </div>
      ),
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
  const failed = stepList.some((step) => step.state === 'failed');
  const noPolling =
    !isReady && !failed && !canPoll
      ? `Progress can't be shown here. Ask the assistant to check with ${checkWith}.`
      : undefined;
  const title = isReady
    ? titles.created
    : failed
      ? titles.failed
      : titles.creating;

  const announce = stepAnnouncement(stepList);
  const timeoutText = `Timed out while polling for ${noun} status.`;
  if (timedOut) announce.polite = timeoutText;
  if (pollError) announce.assertive = pollError;
  if (noPolling) announce.polite = noPolling;

  return {
    announce,
    content: (
      <div className="progress-card">
        <CardHeader
          title={title}
          badge={
            // With a poll error or no polling the step count is stale, so
            // show no badge.
            pollError || noPolling ? undefined : (
              <StepBadge steps={stepList} timedOut={timedOut} />
            )
          }
        >
          {summary(data)}
        </CardHeader>
        {pollError ? (
          <div data-slot="problem" data-tone="danger">
            <XCircleIcon />
            <span>{pollError}</span>
          </div>
        ) : timedOut || noPolling ? (
          <div data-slot="problem" data-tone="muted">
            <span>{noPolling ?? timeoutText}</span>
          </div>
        ) : (
          <StepLine steps={stepList} />
        )}
        {isReady && app && (
          <ReadyActions
            app={app}
            projectRef={projectRef(data)}
            canReachProject={canPoll && canReachProject}
            canOpenLinks={canOpenLinks}
          />
        )}
      </div>
    ),
  };
}

/** The card header: the eyebrow title, an optional badge, then the summary. */
function CardHeader({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div data-slot="header">
      <div data-slot="heading">
        {/* Not announced: the caller announces the state. */}
        <h2 data-slot="title">{title}</h2>
        {badge}
      </div>
      {children}
    </div>
  );
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
    <div className="summary">
      <div data-slot="name">{name}</div>
      <div data-slot="meta">
        {items.map((item) => (
          <span key={item.label}>
            {item.label}: {item.value}
          </span>
        ))}
      </div>
    </div>
  );
}
