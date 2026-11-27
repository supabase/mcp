import '../../shared/button.css';
import type { ReactNode } from 'react';
import { useAnnouncement } from '../../shared/Announcer';
import { RefreshIcon, SpinnerIcon } from '../../shared/icons';
import { readViewData } from '../../shared/tool-result';
import { useMcpView } from '../../shared/use-mcp-view';
import { HANDED_MESSAGE } from './handoff';
import { IssuesList } from './IssuesList';
import { type IssueCategory, type IssueCheck } from './issues-schema';
import type { PartialList } from './list-model';
import { Pager } from './Pager';
import { refreshTool } from './refresh-tool';
import { SelectionBar } from './SelectionBar';
import { type ActiveIssuesView, issueTypeOf, useIssues } from './use-issues';

const TITLE_ID = 'show-issues-title';

/** Shown by a view that a newer one of the same project has retired. */
export const RETIRED_NOTICE =
  'A newer issues view is open elsewhere in this chat.';

const CATEGORY_NAMES: Record<IssueCategory, string> = {
  security: 'Security',
  performance: 'Performance',
  health: 'Health',
};

/** "Health checks could not be read: …", for a category the server couldn't read. */
export function checkNotice(check: IssueCheck) {
  const text = `${CATEGORY_NAMES[check.type]} checks could not be read`;
  return check.reason ? `${text}: ${check.reason}` : `${text}.`;
}

const plural = (count: number, noun: string) =>
  `${count} ${count === 1 ? noun : `${noun}s`}`;

/**
 * View for the `show_issues` tool: a project's issues, five to a page, to
 * select and hand to the assistant with "Review selected (N)".
 */
export function ShowIssues() {
  const view = useMcpView<unknown>('supabase-show-issues', {
    read: readViewData,
    // Read after each render, so `refresh_issues_view` acts on the issues
    // view as `useIssues` returns it below.
    tools: () => [refreshTool(issues)],
  });
  const issues = useIssues(view, issueTypeOf(view.input));
  return issues.status === 'retired' ? (
    <RetiredIssues />
  ) : (
    <ActiveIssues issues={issues} />
  );
}

/** The labelled section and its "Issues" header, which both states share. */
function IssuesScaffold({
  headerEnd,
  children,
}: {
  /** Follows the title in the header. */
  headerEnd?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="show-issues" aria-labelledby={TITLE_ID}>
      {/* The parts' box: it carries the view's width flags, which the
          section, as the width's container, cannot see itself. */}
      <div data-slot="content">
        <header data-slot="header">
          <h2 data-slot="title" id={TITLE_ID}>
            Issues
          </h2>
          {headerEnd}
        </header>
        {children}
      </div>
    </section>
  );
}

/** A retired view: the heading and a notice that points to the newer view. */
function RetiredIssues() {
  useAnnouncement(RETIRED_NOTICE);
  return (
    <IssuesScaffold>
      <ul data-slot="notices">
        <li data-slot="notice">{RETIRED_NOTICE}</li>
      </ul>
    </IssuesScaffold>
  );
}

function ActiveIssues({ issues }: { issues: ActiveIssuesView }) {
  const { list, selecting, server } = issues;

  useAnnouncement(list.announce);
  useAnnouncement(list.alert, 'assertive');
  const handoff =
    selecting?.review.kind === 'message' ? selecting.review.handoff : undefined;
  useAnnouncement(handoff?.status === 'handed' ? HANDED_MESSAGE : undefined);
  useAnnouncement(
    handoff?.status === 'failed' ? handoff.message : undefined,
    'assertive'
  );

  return (
    <IssuesScaffold
      headerEnd={
        server.kind === 'tools' && (
          <RefreshButton
            refreshing={list.refreshing}
            disabled={!list.canRefresh}
            onRefresh={server.refresh}
          />
        )
      }
    >
      <Notices {...list.notices} />

      <IssuesList
        content={list.content}
        reserve={list.reserve}
        selection={
          selecting && {
            isSelected: (key) => selecting.selection.has(key),
            onToggle: selecting.toggle,
          }
        }
      />

      {(list.pager || selecting) && (
        <footer data-slot="footer">
          {list.pager && (
            <Pager
              label={list.range}
              {...list.pager}
              onPrevious={issues.previous}
              onNext={issues.next}
            />
          )}
          {selecting && (
            <SelectionBar
              count={selecting.selection.size}
              action={selecting.review}
              loading={list.loadingAll}
              onClear={selecting.clear}
            />
          )}
        </footer>
      )}
    </IssuesScaffold>
  );
}

/**
 * Reloads from the first page, and the way out of a failed load. Icon-only,
 * named "Refresh"; a disabled spinner while it reloads, and disabled while
 * the first page loads.
 */
function RefreshButton({
  refreshing,
  disabled,
  onRefresh,
}: {
  refreshing: boolean;
  disabled: boolean;
  onRefresh: () => void;
}) {
  return (
    <button
      type="button"
      data-size="sm"
      data-slot="refresh"
      aria-label="Refresh"
      title="Refresh"
      disabled={disabled}
      onClick={onRefresh}
    >
      {refreshing ? <SpinnerIcon /> : <RefreshIcon />}
    </button>
  );
}

/** Checks that couldn't be read, rows that couldn't be shown, and a partial list. */
function Notices({
  unreadChecks,
  dropped,
  partial,
}: {
  unreadChecks: IssueCheck[];
  dropped: number;
  partial?: PartialList;
}) {
  if (unreadChecks.length === 0 && dropped === 0 && !partial) return null;
  return (
    <ul data-slot="notices">
      {unreadChecks.map((check) => (
        <li key={check.type} data-slot="notice" data-tone="warning">
          {checkNotice(check)}
        </li>
      ))}
      {dropped > 0 && (
        <li data-slot="notice" data-tone="warning">
          {plural(dropped, 'issue')} could not be shown.
        </li>
      )}
      {partial && <PartialNotice {...partial} />}
    </ul>
  );
}

/** "Showing 10 of 23. Ask the assistant for the rest." */
function PartialNotice({ shown, total }: PartialList) {
  const showing =
    total === undefined
      ? `Showing the first ${plural(shown, 'issue')}.`
      : `Showing ${shown} of ${total}.`;
  return <li data-slot="notice">{showing} Ask the assistant for the rest.</li>;
}
