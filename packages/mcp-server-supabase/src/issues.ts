import { z } from 'zod/v4';

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
      docs_url: z.string(),
    })
  ),
});
export const issuesResultSchema = z.object({
  issues: z.array(issueSchema),
  checks: z.array(
    z.object({
      type: issueCategorySchema,
      status: z.enum(['complete', 'unavailable']),
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
  const { lints } = z.object({ lints: z.array(lintSchema) }).parse(result);
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
      docs_url,
    };
    const existing = issues.get(lint.name);
    if (existing) {
      existing.affected.push(affected);
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
        affected: [affected],
      });
    }
  }
  return {
    issues: Array.from(issues.values()),
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
