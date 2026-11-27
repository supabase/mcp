/**
 * What `show_issues` sends its view in the result's `_meta`, under
 * `VIEW_DATA_META_KEY`. The `mcp-ui` package imports these types type-only.
 * Fields may be added but never renamed or removed: a host can pair an older
 * view with a newer server, or the other way round.
 */
import type { z } from 'zod/v4';
import type { IssuesPage } from '../issues-page.js';
import type { paginateIssuesInputSchema } from '../tools/show-issues-inputs.js';

export type { IssueSummary, IssuesPage } from '../issues-page.js';

/**
 * Project and connection facts that the view puts in the messages it sends
 * the assistant. When the project cannot be read, `project` carries its id
 * alone.
 */
export type PromptContext = {
  project: {
    id: string;
    ref?: string;
    name?: string;
  };
  connection: {
    readOnly: boolean;
    /** The project this connection is limited to, if any. */
    scopedProjectId: string | null;
  };
};

export type ShowIssuesViewData = {
  /** The first page of issues. */
  page: IssuesPage;
  /** When and for which project the view was opened. */
  opened: { at: number; project: string };
  context: PromptContext;
};

/**
 * The `error.code` in the JSON of an `app_paginate_issues` error result when
 * the cursor is malformed or was made for another request. The view starts
 * over from the first page on it. The text beside it is for the model.
 */
export const INVALID_CURSOR_CODE = 'invalid_cursor';
export type InvalidCursorCode = typeof INVALID_CURSOR_CODE;

/** The app-only tool that pages issues for the view. */
export type PaginateIssuesToolName = 'app_paginate_issues';

type PaginateIssuesSchemaInput = z.input<typeof paginateIssuesInputSchema>;

/**
 * The arguments a caller sends `app_paginate_issues`. `project_id` is
 * optional: a project-scoped server drops it from the schema.
 */
export type PaginateIssuesInput = Omit<
  PaginateIssuesSchemaInput,
  'project_id'
> &
  Partial<Pick<PaginateIssuesSchemaInput, 'project_id'>>;
