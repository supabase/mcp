import { z } from 'zod/v4';
import type { DebuggingOperations } from './platform/types.js';

export const MAX_AFFECTED_PER_ISSUE = 20;

export const issueCategorySchema = z.enum([
  'security',
  'performance',
  'health',
]);
export const issueSeveritySchema = z.enum(['info', 'warning', 'critical']);
export const issueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  severity: issueSeveritySchema,
  category: issueCategorySchema,
  source: z.literal('lint'),
  docs_url: z.string(),
  affected_count: z.number().int().nonnegative(),
  affected: z.array(
    z.object({
      id: z.string(),
      resource: z.object({
        type: z.string(),
        name: z.string(),
        schema: z.string().nullable(),
      }),
      detail: z.string(),
      severity: issueSeveritySchema,
    })
  ),
});
export const issuesResultSchema = z.object({
  issues: z.array(issueSchema),
  /**
   * One entry per category read. `complete` means the read finished,
   * `unavailable` that it was attempted and failed, and `unsupported` that the
   * platform does not offer the category, so nothing was attempted.
   */
  checks: z.array(
    z.object({
      type: issueCategorySchema,
      status: z.enum(['complete', 'unavailable', 'unsupported']),
      reason: z.string().optional(),
    })
  ),
});
export type Issue = z.infer<typeof issueSchema>;
export type IssueCategory = z.infer<typeof issueCategorySchema>;
export type IssueSeverity = z.infer<typeof issueSeveritySchema>;
export type IssuesResult = z.infer<typeof issuesResultSchema>;

const lintSchema = z.object({
  name: z.string().min(1),
  title: z.string(),
  description: z.string(),
  detail: z.string(),
  level: z.enum(['INFO', 'WARN', 'ERROR']),
  remediation: z.string().nullish(),
  cache_key: z.string().optional(),
  metadata: z
    .object({
      type: z.string().optional(),
      name: z.string().optional(),
      schema: z.string().nullish(),
      entity: z.string().optional(),
      arguments: z.string().optional(),
    })
    .nullish(),
});
const severityByLevel = {
  INFO: 'info',
  WARN: 'warning',
  ERROR: 'critical',
} as const;
const severityRank = { info: 0, warning: 1, critical: 2 };
const resourceTypes = new Map([
  ['table', 'table'],
  ['view', 'view'],
  ['materialized view', 'materialized_view'],
  ['foreign table', 'foreign_table'],
  ['function', 'function'],
  ['auth', 'auth'],
  ['extension', 'extension'],
  ['bucket', 'bucket'],
  ['compliance', 'project'],
  ['health', 'project'],
]);
const unescape = (text: string) => text.replace(/\\`/g, '`');

export function normalizeIssues(
  result: unknown,
  category: IssueCategory
): IssuesResult {
  const lints = z
    .array(lintSchema)
    .parse(
      Array.isArray(result)
        ? result
        : z.object({ lints: z.unknown() }).parse(result).lints
    );
  const issues = new Map<string, Issue>();
  const unavailable = lints.filter(
    ({ name }) =>
      name === 'advisor_check_unavailable' || name === 'project_not_active'
  );
  for (const lint of lints) {
    if (unavailable.includes(lint)) continue;
    const metadata = lint.metadata;
    const name = metadata?.entity || metadata?.name;
    const args = metadata?.arguments;
    const resource = name
      ? {
          type:
            resourceTypes.get(metadata?.type ?? '') ??
            (args !== undefined ? 'function' : 'project'),
          name:
            !metadata?.entity && args !== undefined ? `${name}(${args})` : name,
          schema: metadata?.entity ? null : (metadata?.schema ?? null),
        }
      : { type: 'project', name: 'Project', schema: null };
    const severity = severityByLevel[lint.level];
    const docs_url =
      lint.remediation ??
      'https://supabase.com/docs/guides/observability/advisors';
    const affected = {
      id:
        lint.cache_key ??
        JSON.stringify([
          lint.name,
          resource.type,
          resource.schema,
          resource.name,
          lint.detail,
        ]),
      resource,
      detail: unescape(lint.detail),
      severity,
    };
    const existing = issues.get(lint.name);
    if (existing) {
      existing.affected.push(affected);
      existing.affected_count += 1;
      if (severityRank[severity] > severityRank[existing.severity])
        existing.severity = severity;
    } else {
      issues.set(lint.name, {
        id: lint.name,
        title: lint.title,
        description: unescape(lint.description),
        severity,
        category,
        source: 'lint',
        docs_url,
        affected_count: 1,
        affected: [affected],
      });
    }
  }
  return {
    issues: Array.from(issues.values(), (issue) => ({
      ...issue,
      affected: issue.affected
        .sort(
          (a, b) =>
            severityRank[b.severity] - severityRank[a.severity] ||
            a.id.localeCompare(b.id)
        )
        .slice(0, MAX_AFFECTED_PER_ISSUE),
    })),
    checks: [
      {
        type: category,
        status: unavailable.length ? 'unavailable' : 'complete',
        ...(unavailable.length && {
          reason: unavailable
            .map(({ name, detail }) => `${name}: ${unescape(detail)}`)
            .join('; '),
        }),
      },
    ],
  };
}

export function filterAndSortIssues(
  issues: Issue[],
  severity: IssueSeverity
): Issue[] {
  return issues
    .filter((issue) => severityRank[issue.severity] >= severityRank[severity])
    .sort(
      (a, b) =>
        severityRank[b.severity] - severityRank[a.severity] ||
        a.id.localeCompare(b.id)
    );
}

/** Which categories to read: one, or all of them. */
export const issueTypeSchema = z.enum(['all', ...issueCategorySchema.options]);
export type IssueType = z.infer<typeof issueTypeSchema>;

function mustPropagateCheckFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    response?: { status?: unknown };
    cause?: unknown;
  };
  return (
    [value.status, value.statusCode, value.response?.status].some(
      (status) => status === 401 || status === 403
    ) ||
    (typeof value.code === 'number' &&
      value.code >= -32768 &&
      value.code <= -32000) ||
    value.code === 'UNAUTHORIZED' ||
    value.code === 'FORBIDDEN' ||
    (value.cause !== error &&
      value.cause !== undefined &&
      mustPropagateCheckFailure(value.cause))
  );
}

/**
 * The advisor reads this platform supports, bound to `debugging`. `health` is
 * missing where the platform does not implement it, so this is the one place
 * that says which categories are supported.
 */
export function getAdvisorAdapters(debugging: DebuggingOperations) {
  return {
    security: debugging.getSecurityAdvisors.bind(debugging),
    performance: debugging.getPerformanceAdvisors.bind(debugging),
    health: debugging.getHealthAdvisors?.bind(debugging),
  };
}

/**
 * Reads the project's issues for `type`, one advisor check per category in
 * parallel. A category that cannot be read becomes an `unavailable` entry in
 * `checks` instead of failing the whole read, and one the platform lacks an
 * adapter for becomes an `unsupported` entry; authorization and protocol
 * errors still throw. Issues are returned unsorted and unfiltered.
 */
export async function readIssues(
  debugging: DebuggingOperations,
  projectId: string,
  type: IssueType
): Promise<IssuesResult> {
  const advisorAdapters = getAdvisorAdapters(debugging);
  const categories: IssueCategory[] =
    type === 'all' ? ['security', 'performance', 'health'] : [type];
  const results = await Promise.all(
    categories.map(async (category): Promise<IssuesResult> => {
      const adapter = advisorAdapters[category];
      if (!adapter) {
        return {
          issues: [],
          checks: [
            {
              type: category,
              status: 'unsupported',
              reason: 'Health issues are not supported by this platform',
            },
          ],
        };
      }
      try {
        const response = await adapter(projectId, {
          includeUnavailable: true,
        });
        return normalizeIssues(response, category);
      } catch (error) {
        if (mustPropagateCheckFailure(error)) throw error;
        return {
          issues: [],
          checks: [
            {
              type: category,
              status: 'unavailable',
              reason:
                error instanceof Error ? error.message : 'Advisor check failed',
            },
          ],
        };
      }
    })
  );
  return {
    issues: results.flatMap(({ issues }) => issues),
    checks: results.flatMap(({ checks }) => checks),
  };
}
