/**
 * Pages a project's issues for views. Pure: it knows nothing about tools or
 * HTTP, and the caller passes in the time the issues were read.
 *
 * Paging uses a keyset cursor: the sort key of the last row on a page.
 */
import { z } from 'zod/v4';
import {
  issueCategorySchema,
  issueSeveritySchema,
  issuesResultSchema,
  type Issue,
  type IssueCategory,
  type IssuesResult,
  type IssueType,
  issueTypeSchema,
} from './issues.js';

export const ISSUES_PAGE_DEFAULT_LIMIT = 20;
export const ISSUES_PAGE_MAX_LIMIT = 50;

// Paged issues leave out `info`.
const pagedSeveritySchema = issueSeveritySchema.exclude(['info']);

export const issueSummarySchema = z.object({
  id: z.string(),
  category: issueCategorySchema,
  title: z.string(),
  severity: pagedSeveritySchema,
  affected_count: z.number().int().nonnegative(),
});

export const issuesPageSchema = z.object({
  issues: z.array(issueSummarySchema),
  total: z.number().int().nonnegative(),
  counts: z.object({
    all: z.number().int().nonnegative(),
    security: z.number().int().nonnegative(),
    performance: z.number().int().nonnegative(),
    health: z.number().int().nonnegative(),
  }),
  checks: issuesResultSchema.shape.checks,
  next_cursor: z.string().nullable(),
  read_at: z.string(),
});

export type IssueSummary = z.infer<typeof issueSummarySchema>;
export type IssuesPage = z.infer<typeof issuesPageSchema>;

export type SortKey = [
  severity: IssueSummary['severity'],
  category: IssueCategory,
  id: string,
];

const cursorSchema = z.object({
  v: z.literal(1),
  type: issueTypeSchema,
  after: z.tuple([pagedSeveritySchema, issueCategorySchema, z.string()]),
});

/** A cursor that is malformed or was made for a different `type`. */
export class InvalidIssuesCursorError extends Error {
  constructor() {
    super(
      'The cursor is invalid or does not match this request. Request the first page again without a cursor.'
    );
    this.name = 'InvalidIssuesCursorError';
  }
}

export function encodeIssuesCursor(type: IssueType, after: SortKey): string {
  const json = JSON.stringify({ v: 1, type, after });
  const bytes = new TextEncoder().encode(json);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Throws `InvalidIssuesCursorError` unless the cursor is valid for `type`. */
export function decodeIssuesCursor(cursor: string, type: IssueType): SortKey {
  let value: unknown;
  try {
    const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidIssuesCursorError();
  }
  const parsed = cursorSchema.safeParse(value);
  if (!parsed.success || parsed.data.type !== type) {
    throw new InvalidIssuesCursorError();
  }
  return parsed.data.after;
}

const severityOrder: Record<IssueSummary['severity'], number> = {
  critical: 0,
  warning: 1,
};
const categoryOrder: Record<IssueCategory, number> = {
  security: 0,
  performance: 1,
  health: 2,
};

/**
 * Critical first, then security, performance, health, then `id`. Ids compare
 * by code unit, not locale, so every server instance agrees on the order.
 */
function compareKeys(a: SortKey, b: SortKey): number {
  return (
    severityOrder[a[0]] - severityOrder[b[0]] ||
    categoryOrder[a[1]] - categoryOrder[b[1]] ||
    (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0)
  );
}

const keyOf = (issue: IssueSummary): SortKey => [
  issue.severity,
  issue.category,
  issue.id,
];

function toSummary(issue: Issue): IssueSummary | undefined {
  // Info-level issues are never paged.
  if (issue.severity === 'info') return undefined;
  return {
    id: issue.id,
    category: issue.category,
    title: issue.title,
    severity: issue.severity,
    affected_count: issue.affected_count,
  };
}

export type PageIssuesOptions = {
  /** Which category to page. Defaults to `all`. */
  type?: IssueType;
  /** Return only issues after this key. Omit it for the first page. */
  after?: SortKey;
  /** Page size. The caller validates it. */
  limit: number;
  /** When `result` was read. */
  readAt: Date;
};

/**
 * Cuts one page out of a whole project's issues. `counts` always covers the
 * whole project; `total` counts the issues that match `type`. `after` is a
 * key from `decodeIssuesCursor`.
 */
export function pageIssues(
  result: IssuesResult,
  { type = 'all', after, limit, readAt }: PageIssuesOptions
): IssuesPage {
  const all = result.issues
    .flatMap((issue) => toSummary(issue) ?? [])
    .sort((a, b) => compareKeys(keyOf(a), keyOf(b)));
  const counts = { all: all.length, security: 0, performance: 0, health: 0 };
  for (const issue of all) counts[issue.category] += 1;

  const matching =
    type === 'all' ? all : all.filter((issue) => issue.category === type);
  const remaining = after
    ? matching.filter((issue) => compareKeys(keyOf(issue), after) > 0)
    : matching;
  const issues = remaining.slice(0, limit);
  const last = issues.at(-1);

  return {
    issues,
    total: matching.length,
    counts,
    checks: result.checks,
    next_cursor:
      last && remaining.length > limit
        ? encodeIssuesCursor(type, keyOf(last))
        : null,
    read_at: readAt.toISOString(),
  };
}
