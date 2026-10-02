import { z } from 'zod/v4';
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

const DEFAULT_LOGS_DIALECT: LogsDialect = 'clickhouse';

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
      'The start of the log window as an ISO 8601 timestamp, including a UTC "Z" suffix or explicit offset. Defaults to 24 hours before the end of the window. The API caps the requested range at 24 hours.'
    ),
  iso_timestamp_end: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'The end of the log window as an ISO 8601 timestamp, including a UTC "Z" suffix or explicit offset. Defaults to the current time. The API caps the requested range at 24 hours.'
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
        'The start of the log window as an ISO 8601 timestamp, including a UTC "Z" suffix or explicit offset. Defaults to 24 hours before the end of the window. The API caps the requested range at 24 hours.'
      ),
    iso_timestamp_end: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        'The end of the log window as an ISO 8601 timestamp, including a UTC "Z" suffix or explicit offset. Defaults to the current time. The API caps the requested range at 24 hours.'
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
    description: `Runs a custom read-only ${name} SQL query against a Supabase project's ${logsNoun}, for filtering, aggregating, or joining across log fields more precisely than a simple per-service log dump. When the user asks about a specific time range, always pass iso_timestamp_start and iso_timestamp_end to match it; otherwise the query defaults to the last 24 hours and will return results from a wider window than intended. The window can be up to 24 hours. Do not poll this tool in a loop.`,
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
const queryLogsByDialect = {
  clickhouse: buildQueryLogsCopy({
    name: 'ClickHouse',
    logsNoun: 'unified logs stream',
    schemaHint:
      "Logs are exposed through a `logs` table; filter by `source` (common values include 'edge_logs', 'postgres_logs', 'function_edge_logs' for Edge Function invocation/request logs, and 'function_logs' for console output from inside an Edge Function, but this list is not exhaustive — run `select distinct source from logs` to discover the sources available for this project) and read the log line text from `event_message` (the console output or message body); `log_attributes['<key>']` holds only per-row metadata such as level, execution_id and status code.",
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
    description: string;
    parameters: ReturnType<typeof buildQueryLogsInputSchema>;
  }
>;

const queryLogsOutputSchema = z.object({
  result: z.unknown(),
});

const getAdvisorsInputSchema = z.object({
  project_id: z.string(),
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

export const debuggingToolDefs = {
  get_logs: {
    description:
      'Gets logs for a Supabase project by service type. When the user asks about a specific time range, always pass iso_timestamp_start and iso_timestamp_end to match it; otherwise each call defaults to the last 24 hours and will return logs from a wider window than intended. The window can be up to 24 hours. Edge Function logs are split by kind: `edge-function` returns invocation/request logs, while `edge-function-runtime` returns console output from inside the function. Query one service first, then correlate with other services by timestamp or error anchors. Do not poll get_logs in a loop.',
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
      "Gets a list of advisory notices for the Supabase project. Use this to check for security vulnerabilities or performance improvements. Include the remediation URL as a clickable link so that the user can reference the issue themselves. It's recommended to run this tool regularly, especially after making DDL changes to the database since it will catch things like missing RLS policies.",
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
} as const satisfies ToolDefs;

export const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveLogWindow(
  iso_timestamp_start?: string,
  iso_timestamp_end?: string
) {
  const endMs = iso_timestamp_end ? Date.parse(iso_timestamp_end) : Date.now();
  if (Number.isNaN(endMs)) {
    throw new Error(
      `Invalid iso_timestamp_end: "${iso_timestamp_end}". Expected an ISO 8601 timestamp.`
    );
  }

  const startMs = iso_timestamp_start
    ? Date.parse(iso_timestamp_start)
    : endMs - DAY_MS;
  if (Number.isNaN(startMs)) {
    throw new Error(
      `Invalid iso_timestamp_start: "${iso_timestamp_start}". Expected an ISO 8601 timestamp.`
    );
  }

  if (startMs >= endMs) {
    throw new Error('iso_timestamp_start must be before iso_timestamp_end.');
  }

  if (endMs - startMs > DAY_MS) {
    throw new Error('The log window can be at most 24 hours.');
  }

  return {
    iso_timestamp_start: new Date(startMs).toISOString(),
    iso_timestamp_end: new Date(endMs).toISOString(),
  };
}

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
      inject: { project_id },
      execute: async ({ project_id, type }) => {
        let result: unknown;
        switch (type) {
          case 'security':
            result = await debugging.getSecurityAdvisors(project_id);
            break;
          case 'performance':
            result = await debugging.getPerformanceAdvisors(project_id);
            break;
          default:
            throw new Error(`Unknown advisor type: ${type}`);
        }
        return { result: groupAdvisorsResult(result) };
      },
    }),
  };
}
