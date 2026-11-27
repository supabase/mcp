/**
 * `refresh_issues_view`, the view tool the model calls after it changes the
 * project. No `app_` prefix: that marks a server tool only the view calls,
 * and this is the opposite, a view tool the model calls.
 */
import type { McpViewTool } from '../../shared/use-mcp-view';
import type { IssuesView } from './use-issues';

export const REFRESH_TOOL_NAME = 'refresh_issues_view';

export const REFRESH_TOOL_DESCRIPTION =
  "In the open issues view, reload the project's issues. Call this after you change the project so the user sees current issues.";

/**
 * The host doesn't let the view call tools, or a newer view retired it.
 * Opening a new view is a reload too.
 */
export const CANNOT_RELOAD_MESSAGE =
  "This issues view can't reload. Call show_issues to open a new one.";

/** How many issues the list had before a reload and after, where known. */
export type ReloadResult = { before?: number; after?: number };

/** Reloads the list from the first page; rejects with why it failed. */
export type Reload = () => Promise<ReloadResult>;

const issueCount = (count: number) =>
  `${count} ${count === 1 ? 'issue' : 'issues'}`;

/** "Issues reloaded: 21 issues, was 23.", or as much of it as is known. */
export function reloadSummary({ before, after }: ReloadResult) {
  if (after === undefined) {
    return before === undefined
      ? 'Issues reloaded.'
      : `Issues reloaded. There ${before === 1 ? 'was' : 'were'} ${issueCount(before)} before.`;
  }
  return before === undefined
    ? `Issues reloaded: ${issueCount(after)}.`
    : `Issues reloaded: ${issueCount(after)}, was ${before}.`;
}

/**
 * The tool for the issues view as `issues` has it: it reloads a list that
 * can, and fails with `CANNOT_RELOAD_MESSAGE` otherwise. A retired view
 * disables it: the host sends a view tool call to any one of the views that
 * have it, so only the active view keeps it.
 */
export function refreshTool(issues: IssuesView): McpViewTool {
  const reload =
    issues.status === 'active' && issues.server.kind === 'tools'
      ? issues.server.reload
      : undefined;
  return {
    name: REFRESH_TOOL_NAME,
    description: REFRESH_TOOL_DESCRIPTION,
    handler: async () => {
      if (!reload) throw new Error(CANNOT_RELOAD_MESSAGE);
      return reloadSummary(await reload());
    },
    disabled: issues.status === 'retired',
  };
}
