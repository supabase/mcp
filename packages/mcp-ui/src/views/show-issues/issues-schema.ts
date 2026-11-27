/**
 * Parses what the server sends the issues view: the `show_issues` view data
 * and each `app_paginate_issues` page. The view and the server can be
 * different versions (a cached view, a saved chat, a self-hosted server), so
 * nothing is cast. Only the rows are required; every other part falls back on
 * its own, and a row that can't be read is dropped and counted.
 */
import type {
  IssueSummary,
  IssuesPage,
  PromptContext,
  ShowIssuesViewData,
} from '@supabase/mcp-server-supabase/show-issues';
import { z } from 'zod';

export type { IssueSummary } from '@supabase/mcp-server-supabase/show-issues';
export type IssueCategory = IssueSummary['category'];
export type IssueType = 'all' | IssueCategory;
export type IssueCounts = IssuesPage['counts'];
export type IssueCheck = IssuesPage['checks'][number];

/** A row's identity: its category and check id. */
export type IssueKey = `${IssueCategory}:${string}`;

export const issueKey = (issue: IssueSummary): IssueKey =>
  `${issue.category}:${issue.id}`;

export const OUT_OF_STEP_MESSAGE =
  'This view and the server are out of step. Ask the assistant to show the issues again.';

const categorySchema = z.enum(['security', 'performance', 'health']);
const count = z.number().int().nonnegative();

/** Absent when missing or not the expected type. */
const optional = <T extends z.ZodType>(schema: T) =>
  schema.optional().catch(undefined);

const issueSummarySchema = z.object({
  id: z.string(),
  category: categorySchema,
  title: z.string(),
  severity: z.enum(['warning', 'critical']),
  affected_count: count,
});

const checkSchema = z.object({
  type: categorySchema,
  status: z.enum(['complete', 'unavailable', 'unsupported']),
  reason: optional(z.string()),
});

const pageSchema = z.object({
  // Rows are read one by one below, so one bad row doesn't fail the page.
  issues: z.array(z.unknown()),
  total: optional(count),
  counts: optional(
    z.object({
      all: count,
      security: count,
      performance: count,
      health: count,
    })
  ),
  checks: z.array(z.unknown()).catch([]),
  next_cursor: z.string().nullable().catch(null),
  read_at: optional(z.string()),
});

const projectSchema = z.object({
  id: z.string(),
  ref: optional(z.string()),
  name: optional(z.string()),
});

const contextSchema = z.object({
  project: projectSchema,
  connection: optional(
    z.object({
      readOnly: z.boolean(),
      scopedProjectId: z.string().nullable(),
    })
  ),
});

const viewDataSchema = z.object({
  page: z.unknown(),
  opened: optional(z.object({ at: z.number(), project: z.string() })),
  context: z.unknown(),
});

/** An `IssuesPage` as the view reads it: only `issues` is always there. */
export type ParsedIssuesPage = {
  issues: IssueSummary[];
  /** Issues that match the page's `type`. Absent rather than guessed. */
  total?: number;
  counts?: IssueCounts;
  checks: IssueCheck[];
  /** `null` on the last page. */
  next_cursor: string | null;
  read_at?: string;
};

/** The prompt context as the view reads it: the project id at least. */
export type ParsedPromptContext = {
  project: PromptContext['project'];
  connection?: PromptContext['connection'];
};

export type ParsedViewData = {
  page: ParsedIssuesPage;
  /** Absent: the view doesn't take part in retiring older views. */
  opened?: ShowIssuesViewData['opened'];
  /** Absent when the server's context can't be read. */
  context?: ParsedPromptContext;
};

/** A parsed page and how many of its rows couldn't be read. */
export type PageResult = { page: ParsedIssuesPage; dropped: number };

export type ViewDataResult = { data: ParsedViewData; dropped: number };

const outOfStep = () => new Error(OUT_OF_STEP_MESSAGE);

/**
 * Parses an `app_paginate_issues` result. Throws `OUT_OF_STEP_MESSAGE` when
 * it isn't a page at all.
 */
export function parseIssuesPage(raw: unknown): PageResult {
  const parsed = pageSchema.safeParse(raw);
  if (!parsed.success) throw outOfStep();
  const { issues: rows, checks, ...rest } = parsed.data;

  const issues: IssueSummary[] = [];
  for (const row of rows) {
    const issue = issueSummarySchema.safeParse(row);
    if (issue.success) issues.push(issue.data);
  }
  return {
    page: {
      ...rest,
      issues,
      checks: checks.flatMap((check) => {
        const parsed = checkSchema.safeParse(check);
        return parsed.success ? [parsed.data] : [];
      }),
    },
    dropped: rows.length - issues.length,
  };
}

/**
 * Parses the view data `show_issues` sends. The context is absent when it
 * isn't readable. Throws `OUT_OF_STEP_MESSAGE` when the data or its page isn't
 * readable at all.
 */
export function parseViewData(raw: unknown): ViewDataResult {
  const parsed = viewDataSchema.safeParse(raw);
  if (!parsed.success) throw outOfStep();
  const { page, dropped } = parseIssuesPage(parsed.data.page);

  const context = contextSchema.safeParse(parsed.data.context);
  return {
    data: {
      page,
      opened: parsed.data.opened,
      context: context.success ? context.data : undefined,
    },
    dropped,
  };
}

// Compile-time checks that the schemas still match the server's types, so a
// change on either side fails the type check. The server's values must parse
// into the view's types, and a complete view value must be a server value.
type Assert<T extends true> = T;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type SchemaChecks = [
  Assert<Mutual<z.output<typeof issueSummarySchema>, IssueSummary>>,
  Assert<Mutual<z.output<typeof checkSchema>, IssueCheck>>,
  Assert<Mutual<z.output<typeof categorySchema>, IssueCategory>>,
  Assert<IssuesPage extends ParsedIssuesPage ? true : false>,
  Assert<Required<ParsedIssuesPage> extends IssuesPage ? true : false>,
  Assert<
    Mutual<
      NonNullable<z.output<typeof pageSchema>['counts']>,
      IssuesPage['counts']
    >
  >,
  Assert<PromptContext extends ParsedPromptContext ? true : false>,
  Assert<Required<ParsedPromptContext> extends PromptContext ? true : false>,
  Assert<
    z.output<typeof contextSchema> extends ParsedPromptContext ? true : false
  >,
  Assert<Mutual<z.output<typeof projectSchema>, PromptContext['project']>>,
  Assert<ShowIssuesViewData extends ParsedViewData ? true : false>,
];
