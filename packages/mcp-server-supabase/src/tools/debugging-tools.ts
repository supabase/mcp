import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { VIEW_DATA_META_KEY } from '../apps/index.js';
import { resolveLogWindow } from '../logs.js';
import {
  logsServiceSchema,
  type DebuggingOperations,
  type LogsDialect,
} from '../platform/types.js';
import {
  injectableTool,
  type ToolDefs,
  wrapWithUntrustedDataBoundary,
} from './util.js';
import {
  SHOW_ISSUES_UI_URI,
  viewToolMeta,
} from '../resources/app-resources.js';

export const DEFAULT_LOGS_DIALECT: LogsDialect = 'clickhouse';

type DebuggingToolsOptions = {
  debugging: DebuggingOperations;
  projectId?: string;
};

const getLogsInputSchema = z.object({
  project_id: z.string(),
  service: logsServiceSchema.describe('The service to fetch logs for'),
  iso_timestamp_start: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'The start of the log window as an ISO 8601 timestamp, including a UTC "Z" suffix or explicit offset. Defaults to 24 hours before the end of the window. Must be before iso_timestamp_end and at most 24 hours before it (the end defaults to now).'
    ),
  iso_timestamp_end: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'The end of the log window as an ISO 8601 timestamp, including a UTC "Z" suffix or explicit offset. Defaults to the current time. Must be after iso_timestamp_start and at most 24 hours after it.'
    ),
});

const getLogsOutputSchema = z.object({
  result: z.unknown(),
});

function buildQueryLogsInputSchema(sqlDescription: string) {
  return z.object({
    project_id: z.string(),
    sql: z.string().min(1).describe(sqlDescription),
    iso_timestamp_start: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        'The start of the log window as an ISO 8601 timestamp, including a UTC "Z" suffix or explicit offset. Defaults to 24 hours before the end of the window. Must be before iso_timestamp_end and at most 24 hours before it (the end defaults to now).'
      ),
    iso_timestamp_end: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        'The end of the log window as an ISO 8601 timestamp, including a UTC "Z" suffix or explicit offset. Defaults to the current time. Must be after iso_timestamp_start and at most 24 hours after it.'
      ),
  });
}

/**
 * Builds the `query_logs` copy for one dialect from the shared wording, so only
 * the parts that genuinely differ per dialect are supplied: the SQL dialect
 * `name`, the `logsNoun` for how logs are exposed (ClickHouse serves a single
 * unified stream, BigQuery serves per-service tables), and the `schemaHint`.
 */
function buildQueryLogsCopy({
  name,
  logsNoun,
  schemaHint,
}: {
  name: string;
  logsNoun: string;
  schemaHint: string;
}) {
  return {
    schemaHint,
    description: `Runs a custom read-only ${name} SQL query against a Supabase project's ${logsNoun}, for filtering, aggregating, or joining across log fields more precisely than a simple per-service log dump. When the user asks about a specific time range, always pass iso_timestamp_start and iso_timestamp_end to match it; otherwise the query defaults to the last 24 hours and will return results from a wider window than intended. The window must be 24 hours or less and iso_timestamp_start must be before iso_timestamp_end; other windows are rejected. If you pass only iso_timestamp_start, the end defaults to now, so for a past time range pass both timestamps. For a longer range, make one call per 24-hour slice. Do not poll this tool in a loop.`,
    parameters: buildQueryLogsInputSchema(
      `A read-only ${name} SQL query to run against the project's ${logsNoun}. ${schemaHint}`
    ),
  };
}

/**
 * The `query_logs` tool copy, keyed by the dialect its logs endpoint speaks. The
 * whole description and `sql` param hint are swapped per dialect — no conditional
 * prose the model has to reason about. `schemaHint` mirrors how each backend
 * exposes logs: hosted ClickHouse serves a single `logs` table filtered by
 * `source`, while self-hosted BigQuery (Logflare) serves one source table per
 * service with fields nested under `metadata` (see
 * `apps/studio/lib/api/self-hosted/logs.ts` in `supabase`). Precomputed at module
 * level because zod schemas with `.describe()` auto-register in the global
 * registry, so rebuilding them per `getDebuggingTools` call would grow it
 * unboundedly.
 */
export const queryLogsByDialect = {
  clickhouse: buildQueryLogsCopy({
    name: 'ClickHouse',
    logsNoun: 'unified logs stream',
    schemaHint:
      "Logs are exposed through a `logs` table; filter by `source` (common values include 'edge_logs', 'postgres_logs', and 'function_edge_logs', but this list is not exhaustive — run `select distinct source from logs` to discover the sources available for this project) and read nested fields via `log_attributes['<key>']`.",
  }),
  bigquery: buildQueryLogsCopy({
    name: 'BigQuery',
    logsNoun: 'logs',
    schemaHint:
      "Each service has its own source table (common ones include 'edge_logs', 'postgres_logs', and 'function_edge_logs', but the set is not exhaustive — other per-service tables, e.g. Data API and pooler logs, also exist); read nested fields by cross joining `unnest(metadata) as m` and then `m.<field>` (unnest further for nested structs such as `m.request` or `m.parsed`).",
  }),
} as const satisfies Record<
  LogsDialect,
  {
    schemaHint: string;
    description: string;
    parameters: z.ZodType;
  }
>;

const queryLogsOutputSchema = z.object({
  result: z.unknown(),
});

const getAdvisorsInputSchema = z.object({
  project_id: z.string(),
  type: z
    .enum(['security', 'performance', 'health'])
    .describe('The type of advisors to fetch'),
});

const legacyAdvisorsInputSchema = getAdvisorsInputSchema.extend({
  type: z
    .enum(['security', 'performance'])
    .describe('The type of advisors to fetch'),
});

const getAdvisorsOutputSchema = z.object({
  result: z.unknown(),
});

/** Fields the API repeats verbatim on every finding of the same lint. */
const SHARED_LINT_FIELDS: readonly string[] = [
  'name',
  'title',
  'level',
  'facing',
  'categories',
  'description',
  'remediation',
];

/**
 * `cache_key` is mainly used for Studio's advisor UI, for selecting individual
 * lints via the `id` query param. Not meaningful for MCP clients.
 * https://github.com/supabase/supabase/blob/d5ee11bea0cba0149d16715aabb088d03c10be36/apps/studio/pages/project/%5Bref%5D/advisors/security.tsx#L64
 */
const DROPPED_LINT_FIELDS: readonly string[] = ['cache_key'];

type AdvisorLint = Record<string, unknown>;

type GroupedAdvisorLint = {
  count: number;
  findings: AdvisorLint[];
} & AdvisorLint;

function isAdvisorLintArray(value: unknown): value is AdvisorLint[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'object' && item !== null)
  );
}

/**
 * Collapses a flat lint list into one entry per distinct lint, with the
 * per-object findings underneath. Keyed on every shared field, so findings only
 * merge when all of them match.
 */
export function groupAdvisorLints(lints: AdvisorLint[]): GroupedAdvisorLint[] {
  const groups = new Map<string, GroupedAdvisorLint>();

  for (const lint of lints) {
    const shared: AdvisorLint = {};
    const finding: AdvisorLint = {};

    for (const [key, value] of Object.entries(lint)) {
      if (DROPPED_LINT_FIELDS.includes(key)) {
        continue;
      }
      if (SHARED_LINT_FIELDS.includes(key)) {
        shared[key] = value;
      } else {
        finding[key] = value;
      }
    }

    const key = JSON.stringify(shared);

    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.findings.push(finding);
    } else {
      groups.set(key, { ...shared, count: 1, findings: [finding] });
    }
  }

  return Array.from(groups.values());
}

/**
 * Groups the lints in an advisors response and leaves the rest of the payload
 * alone. An unrecognised shape passes through, so an API change degrades to the
 * ungrouped response instead of throwing.
 */
export function groupAdvisorsResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !('lints' in result)) {
    return result;
  }

  const { lints } = result as { lints: unknown };
  if (!isAdvisorLintArray(lints)) {
    return result;
  }

  return { ...result, lints: groupAdvisorLints(lints) };
}

/** Most issue types `show_issues` sends its view per advisor. */
export const SHOW_ISSUES_TYPE_LIMIT = 20;

const showIssuesInputSchema = z.object({
  project_id: z.string(),
});

const issueTypeCountSchema = z
  .number()
  .nullable()
  .describe(
    "Warning and error issue types the advisor found; null when it couldn't be read."
  );

const showIssuesOutputSchema = z.object({
  security: issueTypeCountSchema,
  performance: issueTypeCountSchema,
});

/** One kind of advisor finding, with how many objects it applies to. */
export type AdvisorIssue = {
  name: string;
  title: string;
  level: 'ERROR' | 'WARN';
  count: number;
};

/** One advisor's issues, or why it couldn't be read (never "no issues"). */
export type AdvisorSection =
  | {
      status: 'ready';
      data: { total: number; issues: AdvisorIssue[]; truncated: boolean };
    }
  | { status: 'unavailable'; message: string };

/** What `show_issues` sends its view in result `_meta`. */
export type ShowIssuesViewData = {
  security: AdvisorSection;
  performance: AdvisorSection;
};

/**
 * Summarizes an advisors response as the Supabase surfaces show it: one
 * issue per warning or error lint, errors first, then the most findings.
 */
export function advisorSection(result: unknown): AdvisorSection {
  const lints =
    typeof result === 'object' && result !== null && 'lints' in result
      ? (result as { lints: unknown }).lints
      : undefined;
  if (!isAdvisorLintArray(lints)) {
    return {
      status: 'unavailable',
      message: 'The advisor returned an unexpected response.',
    };
  }

  const issues = new Map<string, AdvisorIssue>();
  for (const lint of lints) {
    const { name, title, level } = lint;
    if (level !== 'ERROR' && level !== 'WARN') continue;
    if (typeof name !== 'string' || typeof title !== 'string') continue;
    const key = JSON.stringify([name, title, level]);
    const issue = issues.get(key);
    if (issue) issue.count += 1;
    else issues.set(key, { name, title, level, count: 1 });
  }

  const sorted = Array.from(issues.values()).sort(
    (a, b) =>
      Number(b.level === 'ERROR') - Number(a.level === 'ERROR') ||
      b.count - a.count ||
      a.title.localeCompare(b.title)
  );
  return {
    status: 'ready',
    data: {
      total: sorted.length,
      issues: sorted.slice(0, SHOW_ISSUES_TYPE_LIMIT),
      truncated: sorted.length > SHOW_ISSUES_TYPE_LIMIT,
    },
  };
}

export const debuggingToolDefs = {
  get_logs: {
    description:
      'Gets logs for a Supabase project by service type. When the user asks about a specific time range, always pass iso_timestamp_start and iso_timestamp_end to match it; otherwise each call defaults to the last 24 hours and will return logs from a wider window than intended. The window must be 24 hours or less and iso_timestamp_start must be before iso_timestamp_end; other windows are rejected. If you pass only iso_timestamp_start, the end defaults to now, so for a past time range pass both timestamps. For a longer range, make one call per 24-hour slice. Edge Function logs are split by kind: `edge-function` returns invocation/request logs, while `edge-function-runtime` returns console output from inside the function. Query one service first, then correlate with other services by timestamp or error anchors. Do not poll get_logs in a loop.',
    parameters: getLogsInputSchema,
    outputSchema: getLogsOutputSchema,
    annotations: {
      title: 'Get project logs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  query_logs: {
    description: queryLogsByDialect[DEFAULT_LOGS_DIALECT].description,
    parameters: queryLogsByDialect[DEFAULT_LOGS_DIALECT].parameters,
    outputSchema: queryLogsOutputSchema,
    annotations: {
      title: 'Query project logs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_advisors: {
    description:
      "Gets a list of advisory notices for the Supabase project. Use this to check for security vulnerabilities, performance improvements, or health issues. Include the remediation URL as a clickable link so that the user can reference the issue themselves. It's recommended to run this tool regularly, especially after making DDL changes to the database since it will catch things like missing RLS policies.",
    parameters: getAdvisorsInputSchema,
    outputSchema: getAdvisorsOutputSchema,
    annotations: {
      title: 'Get project advisors',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  show_issues: {
    description:
      'Shows the user their project\'s security and performance issues from its advisors, as a list where they can send one to you to review. Use it when the user wants to see their issues, such as "what\'s wrong with my project?"; to read advisors yourself, use `get_advisors`. Returns only how many issue types each advisor found: the issues go to the user, not to you.',
    parameters: showIssuesInputSchema,
    outputSchema: showIssuesOutputSchema,
    _meta: viewToolMeta(SHOW_ISSUES_UI_URI, 'panel'),
    annotations: {
      title: 'Show issues',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
} as const satisfies ToolDefs;

export function getDebuggingTools({
  debugging,
  projectId,
}: DebuggingToolsOptions) {
  const project_id = projectId;
  const { queryLogs } = debugging;
  const logsDialect = debugging.logsDialect ?? DEFAULT_LOGS_DIALECT;

  return {
    get_logs: injectableTool({
      ...debuggingToolDefs.get_logs,
      // query_logs supersedes get_logs wherever ClickHouse-backed querying is
      // available; keep get_logs callable for platforms/clients without it.
      hidden: Boolean(queryLogs),
      inject: { project_id },
      execute: async ({
        project_id,
        service,
        iso_timestamp_start,
        iso_timestamp_end,
      }) => {
        const result = await debugging.getLogs(project_id, {
          service,
          ...resolveLogWindow(iso_timestamp_start, iso_timestamp_end),
        });
        return { result: wrapWithUntrustedDataBoundary(result) };
      },
    }),
    ...(queryLogs && {
      query_logs: injectableTool({
        ...debuggingToolDefs.query_logs,
        // Pick the whole description/param hint for the platform's dialect
        // rather than branching on the environment inside the prose.
        description: queryLogsByDialect[logsDialect].description,
        parameters: queryLogsByDialect[logsDialect].parameters,
        inject: { project_id },
        execute: async ({
          project_id,
          sql,
          iso_timestamp_start,
          iso_timestamp_end,
        }) => {
          const result = await queryLogs(project_id, {
            sql,
            ...resolveLogWindow(iso_timestamp_start, iso_timestamp_end),
          });
          return { result: wrapWithUntrustedDataBoundary(result) };
        },
      }),
    }),
    get_advisors: injectableTool({
      ...debuggingToolDefs.get_advisors,
      parameters: debugging.getHealthAdvisors
        ? getAdvisorsInputSchema
        : legacyAdvisorsInputSchema,
      inject: { project_id },
      execute: async ({
        project_id,
        type,
      }: z.infer<typeof getAdvisorsInputSchema>) => {
        let result: unknown;
        switch (type) {
          case 'security':
            result = await debugging.getSecurityAdvisors(project_id);
            break;
          case 'performance':
            result = await debugging.getPerformanceAdvisors(project_id);
            break;
          case 'health':
            if (!debugging.getHealthAdvisors) {
              throw new Error(
                'Health advisors are not supported by this platform'
              );
            }
            result = await debugging.getHealthAdvisors(project_id);
            break;
          default:
            throw new Error(`Unknown advisor type: ${type}`);
        }
        return { result: groupAdvisorsResult(result) };
      },
    }),
    show_issues: injectableTool({
      ...debuggingToolDefs.show_issues,
      inject: { project_id },
      execute: async ({ project_id }): Promise<CallToolResult> => {
        // Each advisor stands alone: one that fails shows as unavailable.
        const read = async (
          get: (projectId: string) => Promise<unknown>
        ): Promise<AdvisorSection> => {
          try {
            return advisorSection(await get(project_id));
          } catch (error) {
            return {
              status: 'unavailable',
              message: error instanceof Error ? error.message : String(error),
            };
          }
        };
        const [security, performance] = await Promise.all([
          read((id) => debugging.getSecurityAdvisors(id)),
          read((id) => debugging.getPerformanceAdvisors(id)),
        ]);
        const viewData: ShowIssuesViewData = { security, performance };
        const count = (section: AdvisorSection) =>
          section.status === 'ready' ? section.data.total : null;
        return {
          // The model gets counts; the issues go to the view alone.
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                security: count(security),
                performance: count(performance),
              }),
            },
          ],
          _meta: { [VIEW_DATA_META_KEY]: viewData },
        };
      },
    }),
  };
}
