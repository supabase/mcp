/**
 * The inputs of `show_issues` and `app_paginate_issues`, apart from the other
 * debugging tools so the view's types (`src/apps/show-issues.ts`) can reach
 * them without pulling in the tools.
 */
import { z } from 'zod/v4';
import { issueTypeSchema } from '../issues.js';
import {
  ISSUES_PAGE_DEFAULT_LIMIT,
  ISSUES_PAGE_MAX_LIMIT,
} from '../issues-page.js';

export const showIssuesInputSchema = z.object({
  project_id: z.string(),
  type: issueTypeSchema.default('all'),
});

export const paginateIssuesInputSchema = showIssuesInputSchema.extend({
  cursor: z
    .string()
    .optional()
    .describe(
      'The next_cursor of the previous page. Omit it for the first page.'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ISSUES_PAGE_MAX_LIMIT)
    .default(ISSUES_PAGE_DEFAULT_LIMIT),
});
