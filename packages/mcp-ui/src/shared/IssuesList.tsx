import './button.css';
import './issues-list.css';

import { type ReactNode, useId, useRef, useState } from 'react';

import { Admonition } from './Admonition';
import { CircleAlertIcon, CircleCheckIcon, TriangleAlertIcon } from './icons';

export const ADVISOR_CATEGORIES = {
  security: 'Security',
  performance: 'Performance',
} as const;
export type AdvisorCategory = keyof typeof ADVISOR_CATEGORIES;
const CATEGORIES = Object.keys(ADVISOR_CATEGORIES) as AdvisorCategory[];

/** Most issue types the server sends per category (`SHOW_ISSUES_TYPE_LIMIT`). */
const ADVISOR_ISSUE_LIMIT = 20;

/** One kind of advisor finding (`AdvisorIssue` in mcp-server-supabase). */
export type AdvisorIssue = {
  name: string;
  title: string;
  level: 'ERROR' | 'WARN';
  count: number;
};

/** One advisor's issues, or why it couldn't be read (never "no issues"). */
export type AdvisorSection =
  | {
      status: 'ready';
      data: { total: number; issues: AdvisorIssue[]; truncated: boolean };
    }
  | { status: 'unavailable'; message: string };

export type ProjectIssues = Record<AdvisorCategory, AdvisorSection>;

/** The issues as read so far. */
export type LoadedIssues =
  | { status: 'loading' }
  | { status: 'success'; data: ProjectIssues }
  | { status: 'error'; message: string };

function IssueRow({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title?: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <li data-slot="issue">
      {icon}
      <span data-slot="issue-text">
        {title && <span data-slot="issue-title">{title}</span>}
        <span data-slot="issue-description">{description}</span>
      </span>
      {action}
    </li>
  );
}

const levelLabel = (level: AdvisorIssue['level']) =>
  level === 'ERROR' ? 'Error' : 'Warning';

function CategoryRows({
  category,
  issues,
  canReview,
  onReview,
}: {
  category: AdvisorCategory;
  issues: ProjectIssues;
  canReview: boolean;
  onReview: (category: AdvisorCategory, issue: AdvisorIssue) => void;
}) {
  const label = ADVISOR_CATEGORIES[category];
  const result = issues[category];

  // A section that failed is shown as unavailable, never as "no issues".
  if (result.status === 'unavailable')
    return <IssueRow title={label} description={result.message} />;

  if (result.data.total === 0) {
    return (
      <IssueRow
        icon={<CircleCheckIcon slot="issue-icon" />}
        title={`No ${label.toLowerCase()} issues`}
        description={`${label} Advisor found no warnings or errors.`}
      />
    );
  }

  return (
    <>
      {result.data.issues.map((issue) => (
        <IssueRow
          key={`${category}:${issue.name}:${issue.level}:${issue.title}`}
          icon={
            <span
              role="img"
              aria-label={levelLabel(issue.level)}
              data-slot="issue-level"
              data-tone={issue.level === 'ERROR' ? 'destructive' : 'warning'}
            >
              {issue.level === 'ERROR' ? (
                <CircleAlertIcon />
              ) : (
                <TriangleAlertIcon />
              )}
            </span>
          }
          title={issue.title}
          description={`${label} · ${levelLabel(issue.level)} · ${issue.count} ${issue.count === 1 ? 'finding' : 'findings'}`}
          action={
            <button
              type="button"
              data-size="sm"
              disabled={!canReview}
              aria-label={`Review ${issue.title}`}
              aria-description="Send this finding to chat for review."
              onClick={() => onReview(category, issue)}
            >
              Review
            </button>
          }
        />
      ))}
      {result.data.truncated && (
        <IssueRow
          description={`Showing the first ${ADVISOR_ISSUE_LIMIT} ${label.toLowerCase()} issue types.`}
        />
      )}
    </>
  );
}

/**
 * A project's open issues from its security and performance advisors, after
 * the surfaces' IssuesList: one row per failing check, each of which the user
 * can send to the agent to review. A send is confirmed beside the heading,
 * and a failed one is shown below the list.
 */
export function IssuesList({
  issues,
  onRefresh,
  onReview,
}: {
  issues: LoadedIssues;
  /** Reads the issues again. Omit to hide Refresh. */
  onRefresh?: () => void;
  /** Sends one issue to the agent. Omit when the host can't; Review is then disabled. */
  onReview?: (category: AdvisorCategory, issue: AdvisorIssue) => Promise<void>;
}) {
  const titleId = useId();
  const [isSending, setIsSending] = useState(false);
  const [sendResult, setSendResult] = useState<
    { status: 'sent' } | { status: 'error'; message: string }
  >();
  const lock = useRef(false);
  const isLoading = issues.status === 'loading';
  const canReview = !!onReview && !isSending;

  async function handleReview(category: AdvisorCategory, issue: AdvisorIssue) {
    if (!onReview || lock.current) return;
    lock.current = true;
    setIsSending(true);
    setSendResult(undefined);
    try {
      await onReview(category, issue);
      setSendResult({ status: 'sent' });
    } catch (error) {
      setSendResult({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      lock.current = false;
      setIsSending(false);
    }
  }

  return (
    <section
      className="issues-list"
      aria-labelledby={titleId}
      aria-busy={isLoading}
    >
      <div data-slot="header">
        <h2 data-slot="title" id={titleId}>
          Issues
        </h2>
        {/* Always rendered so the confirmation is announced. */}
        <p data-slot="status" role="status">
          {sendResult?.status === 'sent' ? 'Sent to chat.' : ''}
        </p>
        {onRefresh && (
          <button
            type="button"
            data-size="sm"
            data-slot="refresh"
            disabled={isLoading}
            onClick={onRefresh}
          >
            Refresh
          </button>
        )}
      </div>
      <ul data-slot="list">
        {issues.status === 'loading' && (
          <IssueRow description="Loading issues…" />
        )}
        {issues.status === 'error' && (
          <IssueRow
            title="Issues are unavailable"
            description={issues.message}
          />
        )}
        {issues.status === 'success' &&
          CATEGORIES.map((category) => (
            <CategoryRows
              key={category}
              category={category}
              issues={issues.data}
              canReview={canReview}
              onReview={(category, issue) => void handleReview(category, issue)}
            />
          ))}
      </ul>
      {sendResult?.status === 'error' && (
        <Admonition
          type="destructive"
          title="Failed to send to chat"
          description={sendResult.message}
        />
      )}
    </section>
  );
}
