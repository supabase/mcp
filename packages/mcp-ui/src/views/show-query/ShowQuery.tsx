import {
  QueryEditor,
  type QueryRun,
  type RunQuery,
} from '../../shared/QueryEditor';
import { logRows, sqlRows, type Row } from '../../shared/sql-result';
import { useMcpView } from '../../shared/use-mcp-view';

/**
 * What `show_query` sends the view in its result's `_meta`
 * (`ShowQueryViewData` in mcp-server-supabase
 * `src/tools/database-operation-tools.ts`).
 */
type ShowQueryViewData = {
  rows: Row[];
  /** More rows came back than the tool sends, so the rest were dropped. */
  truncated: boolean;
  /** The log window the tool resolved, for source "logs". */
  iso_timestamp_start?: string;
  iso_timestamp_end?: string;
};

/**
 * A short label for the window a log query reads, as the surfaces' footer
 * shows it (`logWindowLabel` in the Supabase surfaces).
 */
function logWindowLabel(start?: string, end?: string) {
  if (!start || !end) return 'Last 24 hours';
  const minutes = (Date.parse(end) - Date.parse(start)) / 60_000;
  if (minutes < 60) return `${Number(minutes.toFixed(1))} min window`;
  return `${Number((minutes / 60).toFixed(1))}h window`;
}

/**
 * View for the `show_query` tool: the query the model chose and its rows, in
 * an editor the user can change and run again. The tool runs the first query
 * read-only; the user's own runs go through `execute_sql` or `query_logs`, so
 * the server's usual permissions and confirmations apply to them.
 */
export function ShowQuery() {
  const { toolCall, callTool, inputText, expand } =
    useMcpView<ShowQueryViewData>('supabase-show-query', {
      // Inline, and the user can move it to a panel (`viewResourceMeta`).
      displayModes: ['inline', 'fullscreen'],
    });

  const source = inputText('source') === 'logs' ? 'logs' : 'database';
  const sql = inputText('sql');
  // Project-scoped servers drop `project_id` from tool inputs, and reject it
  // if sent, so the view passes it on only when the call had one.
  const projectId = inputText('project_id');
  const target = projectId ? { project_id: projectId } : {};

  const data = toolCall.status === 'ready' ? toolCall.data : undefined;
  // Reruns read the window the tool resolved, so they match the first run.
  const window = {
    iso_timestamp_start:
      data?.iso_timestamp_start ?? inputText('iso_timestamp_start'),
    iso_timestamp_end:
      data?.iso_timestamp_end ?? inputText('iso_timestamp_end'),
  };

  const delivered: QueryRun =
    toolCall.status === 'loading'
      ? { status: 'running' }
      : toolCall.status === 'ready'
        ? {
            status: 'done',
            rows: toolCall.data.rows,
            truncated: toolCall.data.truncated,
            sql: sql ?? '',
          }
        : {
            status: 'error',
            message:
              toolCall.status === 'cancelled'
                ? 'The query was cancelled.'
                : toolCall.message,
          };

  const onRun: RunQuery | undefined =
    callTool &&
    (async (query) => {
      const rows =
        source === 'logs'
          ? logRows(
              await callTool<{ result: unknown }>('query_logs', {
                ...target,
                sql: query,
                ...window,
              })
            )
          : sqlRows(
              await callTool<{ result: string }>('execute_sql', {
                ...target,
                query,
              })
            );
      return { rows, truncated: false };
    });

  const { iso_timestamp_start: start, iso_timestamp_end: end } = window;
  const footerDetail =
    source === 'logs'
      ? {
          label: `Logs · ${logWindowLabel(start, end)}`,
          title:
            start && end
              ? `${new Date(start).toLocaleString()} – ${new Date(end).toLocaleString()}`
              : 'Queries the last 24 hours',
        }
      : undefined;

  return (
    <QueryEditor
      title={inputText('title') ?? 'Query results'}
      sql={sql}
      delivered={delivered}
      onRun={onRun}
      source={source}
      footerDetail={footerDetail}
      onExpand={expand}
    />
  );
}
