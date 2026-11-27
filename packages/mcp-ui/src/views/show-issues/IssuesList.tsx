import type { CSSProperties } from 'react';
import { CheckIcon } from '../../shared/icons';
import { Message } from '../../shared/Message';
import { IssueRow } from './IssueRow';
import { type IssueKey, type IssueSummary, issueKey } from './issues-schema';
import type { ListContent } from './list-model';

/** Selecting rows: whether each is selected, and what a toggle does. */
export type RowSelection = {
  isSelected: (key: IssueKey) => boolean;
  onToggle: (issue: IssueSummary) => void;
};

/**
 * One view page of issues, or what stands in for it: loading rows, the
 * error, or the empty state. Once the list has more than one page, it keeps
 * a full page's height (`reserve`, the rows per page), so a short last page
 * doesn't make the chat jump. Rows have checkboxes only with `selection`.
 */
export function IssuesList({
  content,
  reserve,
  selection,
}: {
  content: ListContent;
  reserve?: number;
  selection?: RowSelection;
}) {
  return (
    <ul
      className="issues-list"
      data-reserve={reserve !== undefined}
      style={
        reserve === undefined
          ? undefined
          : ({ '--sb-view-show-issues-page-size': reserve } as CSSProperties)
      }
    >
      <ListItems content={content} selection={selection} />
    </ul>
  );
}

/** The list's items for its content. */
function ListItems({
  content,
  selection,
}: {
  content: ListContent;
  selection?: RowSelection;
}) {
  switch (content.status) {
    case 'unavailable':
      return <UnavailableStatus reason={content.reason} />;
    case 'loading':
      return <LoadingRows count={content.rows} />;
    case 'failed':
      return <FailedStatus {...content} />;
    case 'empty':
      return <EmptyStatus {...content} />;
    case 'ready':
      return <IssueRows items={content.items} selection={selection} />;
    default:
      return content satisfies never;
  }
}

/** The tool call that opened the view gave no list. */
function UnavailableStatus({ reason }: { reason: string }) {
  return (
    <li data-slot="status" data-state="unavailable">
      <Message tone="error">Issues are unavailable. {reason}</Message>
    </li>
  );
}

/** A page of placeholder rows, each shaped like an issue's two lines. */
function LoadingRows({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <li key={index} data-slot="skeleton-row" aria-hidden="true">
      <span data-slot="skeleton" data-width="long" />
      <span data-slot="skeleton" data-width="short" />
    </li>
  ));
}

/** Why the page couldn't be loaded. Refresh, in the header, starts over. */
function FailedStatus({ message }: Extract<ListContent, { status: 'failed' }>) {
  return (
    <li data-slot="status" data-state="failed">
      <Message tone="error">{message}</Message>
    </li>
  );
}

/** No issues: all clear, or only in the checks that could be read. */
function EmptyStatus({
  incompleteChecks,
}: Extract<ListContent, { status: 'empty' }>) {
  if (incompleteChecks) {
    return (
      <li data-slot="status" data-state="empty">
        <Message>No issues found in the checks that could be read.</Message>
      </li>
    );
  }
  return (
    <li data-slot="status" data-state="empty">
      <CheckIcon slot="empty-icon" />
      <Message>No issues found</Message>
    </li>
  );
}

/** The page's issues, one row each. */
function IssueRows({
  items,
  selection,
}: {
  items: IssueSummary[];
  selection?: RowSelection;
}) {
  return items.map((issue) => {
    const key = issueKey(issue);
    return (
      <IssueRow
        key={key}
        issue={issue}
        checkbox={
          selection && {
            checked: selection.isSelected(key),
            onToggle: selection.onToggle,
          }
        }
      />
    );
  });
}
