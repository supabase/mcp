/**
 * Where the report gets its data. Structurally identical to
 * `SupabasePlatform['debugging']['queryLogs']` so a platform can be adapted by
 * passing the method straight through. The API body looks like
 * `{ result?: unknown[]; error?: unknown }`.
 */
export interface ApiGatewayReportDataSource {
  queryLogs(
    projectId: string,
    options: {
      sql: string;
      iso_timestamp_start?: string;
      iso_timestamp_end?: string;
    }
  ): Promise<unknown>;
}
