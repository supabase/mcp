import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  type Resource,
  serverExtension,
  type ServerExtension,
  tool,
} from '@supabase/mcp-utils';
import { z } from 'zod/v4';
import html from '../dist-ui/api-gateway-report.html';
import {
  API_GATEWAY_REPORT_RESOURCE_URI,
  DEFAULT_TIME_RANGE,
  GET_API_GATEWAY_REPORT_DATA_TOOL,
  MCP_APP_MIME_TYPE,
  SHOW_API_GATEWAY_REPORT_TOOL,
  UI_EXTENSION_ID,
} from './constants.js';
import type { ApiGatewayReportDataSource } from './data-source.js';
import { resolveWindow, routesQuery, timeseriesQuery } from './queries.js';
import {
  apiGatewayReportSchema,
  timeRangeSchema,
  type ApiGatewayReport,
} from './schema.js';
import { summarizeReport, wrapWithUntrustedDataBoundary } from './summary.js';
import { buildReport, describeError } from './transform.js';

export type ApiGatewayReportExtensionOptions = {
  dataSource: ApiGatewayReportDataSource;
  /** When set, tools are scoped to this project and `project_id` is omitted from their schemas. */
  projectId?: string;
  /** Clock override, mainly for tests. */
  now?: () => Date;
};

const parametersSchema = z.object({
  project_id: z.string().describe('The project ID (reference) to report on'),
  time_range: timeRangeSchema
    .default(DEFAULT_TIME_RANGE)
    .describe('How far back to look, up to 24 hours'),
});

// `parameters` is widened to `z.ZodObject<any>` below, so `execute` gets
// untyped args. Parse them again rather than casting: `project_id` is absent
// when the extension is scoped to a project.
const runArgsSchema = parametersSchema.partial({ project_id: true });

const TOOL_META = {
  ui: { resourceUri: API_GATEWAY_REPORT_RESOURCE_URI },
  // Legacy key, read by older MCP Apps hosts.
  'ui/resourceUri': API_GATEWAY_REPORT_RESOURCE_URI,
} as const;

const RESOURCE_META = {
  ui: {
    csp: { connectDomains: [], resourceDomains: [] },
    prefersBorder: true,
  },
} as const;

const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function reportError(timeseriesError: string, routesError: string) {
  return new Error(
    `Failed to load API gateway report data. Time series: ${timeseriesError}. Routes: ${routesError}`
  );
}

async function generateReport(
  dataSource: ApiGatewayReportDataSource,
  projectId: string,
  timeRange: z.infer<typeof timeRangeSchema>,
  now: Date
): Promise<ApiGatewayReport> {
  const window = resolveWindow(timeRange, now);
  const range = {
    iso_timestamp_start: window.start.toISOString(),
    iso_timestamp_end: window.end.toISOString(),
  };

  const [timeseries, routes] = await Promise.allSettled([
    dataSource.queryLogs(projectId, {
      sql: timeseriesQuery(window.bucket),
      ...range,
    }),
    dataSource.queryLogs(projectId, { sql: routesQuery(), ...range }),
  ]);

  if (timeseries.status === 'rejected' && routes.status === 'rejected') {
    throw reportError(
      describeError(timeseries.reason),
      describeError(routes.reason)
    );
  }

  const report = buildReport({
    projectId,
    timeRange,
    window,
    now,
    timeseries,
    routes,
  });

  // A 200 response carrying an `error` field counts as failure too.
  if (report.timeseries.error && report.topRoutes.error) {
    throw reportError(report.timeseries.error, report.topRoutes.error);
  }
  return report;
}

/**
 * Creates the API gateway report MCP App: a model-visible tool that renders the
 * report, an app-only refresh tool, and the HTML resource. Declares the
 * `io.modelcontextprotocol/ui` extension capability.
 */
export function apiGatewayReportExtension(
  opts: ApiGatewayReportExtensionOptions
): ServerExtension {
  const { dataSource, projectId } = opts;
  const now = opts.now ?? (() => new Date());

  const scoped = projectId !== undefined;
  const parameters = (
    scoped ? parametersSchema.omit({ project_id: true }) : parametersSchema
  ) as z.ZodObject<any>;

  async function run(rawArgs: Record<string, unknown>) {
    const args = runArgsSchema.parse(rawArgs);
    const id = projectId ?? args.project_id;
    if (!id) throw new Error('project_id is required');
    return generateReport(dataSource, id, args.time_range, now());
  }

  const showTool = tool({
    description:
      "Shows an API gateway report for a Supabase project: request volume, 4xx/5xx errors, average and p95 latency over time, and the top, top-error and slowest routes. Use it when the user asks how their project's API (REST, Auth, Storage, Edge Functions traffic through the gateway) is performing, whether it is erroring, or what is slow. In hosts that support MCP Apps this renders an interactive chart the user can re-scope to another time range; otherwise it returns a text summary. Covers the last 10 minutes to 24 hours. Prefer this over writing log SQL for general traffic overviews.",
    annotations: { title: 'Show API gateway report', ...ANNOTATIONS },
    parameters,
    outputSchema: apiGatewayReportSchema,
    _meta: TOOL_META,
    execute: async (args): Promise<CallToolResult> => {
      const report = await run(args);
      return {
        content: [
          {
            type: 'text',
            text: wrapWithUntrustedDataBoundary(summarizeReport(report)),
          },
        ],
        structuredContent: report,
      };
    },
  });

  const dataTool = tool({
    description:
      'Fetches API gateway report data for the report UI. Only callable by the app, not the model.',
    annotations: { title: 'Get API gateway report data', ...ANNOTATIONS },
    parameters,
    outputSchema: apiGatewayReportSchema,
    _meta: { ...TOOL_META, ui: { ...TOOL_META.ui, visibility: ['app'] } },
    execute: async (args): Promise<CallToolResult> => {
      const report = await run(args);
      return {
        content: [
          {
            type: 'text',
            text: wrapWithUntrustedDataBoundary(summarizeReport(report)),
          },
        ],
        structuredContent: report,
      };
    },
  });

  const reportResource: Resource<string, unknown> = {
    uri: API_GATEWAY_REPORT_RESOURCE_URI,
    name: 'api-gateway-report',
    description:
      'Interactive API gateway report (requests, errors, latency, top routes) for MCP Apps hosts.',
    mimeType: MCP_APP_MIME_TYPE,
    _meta: RESOURCE_META,
    // Hosts read CSP and border preferences from the content item first.
    read: async (uri) => ({
      uri,
      mimeType: MCP_APP_MIME_TYPE,
      text: html,
      _meta: RESOURCE_META,
    }),
  };

  return serverExtension({
    tools: {
      [SHOW_API_GATEWAY_REPORT_TOOL]: showTool,
      [GET_API_GATEWAY_REPORT_DATA_TOOL]: dataTool,
    },
    resources: [reportResource],
    extensions: { [UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
  });
}
