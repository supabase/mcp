import type { SupabaseExtensionFactory } from './server.js';

export type ExperimentalExtensionOptions = {
  /** Enable the MCP Apps extension (`--experimental-apps` / `experimental_apps=true`). */
  apps?: boolean;
};

/**
 * Maps experimental flags to extension factories. Both the CLI and the local
 * HTTP entry go through this so other hosts can reuse it.
 */
export async function loadExperimentalExtensions(
  opts: ExperimentalExtensionOptions
): Promise<SupabaseExtensionFactory[]> {
  const extensions: SupabaseExtensionFactory[] = [];

  if (opts.apps) {
    // Dynamic import so default runs never load the apps package (or its
    // embedded UI bundle).
    const { apiGatewayReportExtension } = await import(
      '@supabase/mcp-apps-supabase'
    );

    extensions.push(({ platform, projectId }) => {
      const debugging = platform.debugging;
      // The report's queries are ClickHouse SQL; `logsDialect` defaults to
      // ClickHouse when unset. Otherwise contribute nothing.
      if (
        !debugging?.queryLogs ||
        (debugging.logsDialect !== undefined &&
          debugging.logsDialect !== 'clickhouse')
      ) {
        return {};
      }
      const queryLogs = debugging.queryLogs.bind(debugging);
      return apiGatewayReportExtension({
        dataSource: { queryLogs },
        projectId,
      });
    });
  }

  return extensions;
}
