import type {
  PaginateIssuesInput,
  PaginateIssuesToolName,
} from '@supabase/mcp-server-supabase/show-issues';
import type { CallTool } from '../../shared/call-tool';
import {
  type IssueType,
  type PageResult,
  parseIssuesPage,
} from './issues-schema';

/** The app-only server tool that pages a project's issues for this view. */
export const PAGINATE_ISSUES_TOOL: PaginateIssuesToolName =
  'app_paginate_issues';

export type FetchIssuesPageRequest = {
  type: IssueType;
  /** The previous page's `next_cursor`; `null` for the first page. */
  cursor: string | null;
  /**
   * Only when the view knows it (from the tool input or context): a
   * project-scoped server has no `project_id` input.
   */
  projectId?: string;
};

/**
 * Reads one page of issues from the server. Throws a readable `Error` when
 * the call fails or the result isn't a page (see `parseIssuesPage`).
 */
export async function fetchIssuesPage(
  callTool: CallTool,
  { type, cursor, projectId }: FetchIssuesPageRequest
): Promise<PageResult> {
  // Set key by key: properties spread into a literal escape the excess
  // property check, so a renamed parameter would still typecheck.
  const args: PaginateIssuesInput = {};
  if (projectId) args.project_id = projectId;
  args.type = type;
  if (cursor) args.cursor = cursor;
  const raw = await callTool<unknown>(PAGINATE_ISSUES_TOOL, args);
  return parseIssuesPage(raw);
}
