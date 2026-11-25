import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LogWindow,
  QUERY_BLOCK_LABEL,
  type QueryBlock,
  type QueryBlockChange,
  type QuerySource,
  queryBlockContext,
  queryBlockTools,
} from '../../shared/query-block-agent';
import {
  QueryEditor,
  type QueryEditorHandle,
  type QueryEditorState,
  type QueryRun,
  type RunQuery,
} from '../../shared/QueryEditor';
import { logRows, sqlRows, type Row } from '../../shared/sql-result';
import { useMcpView } from '../../shared/use-mcp-view';
import {
  createContextSharer,
  registerViewTools,
} from '../../shared/view-agent';

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
  // The open block, for the tools the agent calls; current as of each render.
  const block = useRef<QueryBlock | undefined>(undefined);
  const editor = useRef<QueryEditorHandle>(null);
  const { toolCall, callTool, inputText, app, hostContext, expand } =
    useMcpView<ShowQueryViewData>('supabase-show-query', {
      onAppCreated: (app) =>
        registerViewTools(
          app,
          queryBlockTools(() =>
            block.current
              ? { ...block.current, editor: editor.current }
              : undefined
          ),
          { label: QUERY_BLOCK_LABEL }
        ),
      // Inline, and the user can move it to a panel (`viewResourceMeta`).
      displayModes: ['inline', 'fullscreen'],
    });

  // What the block runs against: what the tool call opened it with, until
  // the agent changes it (`edit_query_view`).
  const [changes, setChanges] = useState<QueryBlockChange>({});
  const openedSource: QuerySource =
    inputText('source') === 'logs' ? 'logs' : 'database';
  const sql = inputText('sql');
  const data = toolCall.status === 'ready' ? toolCall.data : undefined;
  // Reruns read the window the tool resolved, so they match the first run.
  const openedWindow: LogWindow = {
    iso_timestamp_start:
      data?.iso_timestamp_start ?? inputText('iso_timestamp_start'),
    iso_timestamp_end:
      data?.iso_timestamp_end ?? inputText('iso_timestamp_end'),
  };
  const source = changes.source ?? openedSource;
  const window = changes.window ?? openedWindow;
  const title = changes.title ?? inputText('title') ?? 'Query results';
  // The tool call's id where the host gives one, so each block in a
  // conversation answers only edits meant for it.
  const fallbackId = useMemo(() => crypto.randomUUID(), []);
  const toolCallId = hostContext?.toolInfo?.id;
  block.current = {
    id: toolCallId === undefined ? fallbackId : String(toolCallId),
    title,
    source,
    window,
    editor: editor.current,
    retarget: (change) => {
      const defined = Object.fromEntries(
        Object.entries(change).filter(([, value]) => value !== undefined)
      ) as QueryBlockChange;
      // Current at once, so the tool's answer and the next call see it.
      if (block.current) block.current = { ...block.current, ...defined };
      setChanges((current) => ({ ...current, ...defined }));
    },
  };

  const shareContext = useMemo(
    () => (app ? createContextSharer(app) : undefined),
    [app]
  );
  const handleStateChange = useCallback(
    (state: QueryEditorState) => {
      if (block.current)
        shareContext?.(queryBlockContext(block.current, state));
    },
    [shareContext]
  );
  // A new source, window or title changes what the agent sees even when the
  // editor's state doesn't.
  const targetKey = JSON.stringify([source, window, title]);
  useEffect(() => {
    const state = editor.current?.read();
    if (block.current && state)
      shareContext?.(queryBlockContext(block.current, state));
  }, [shareContext, targetKey]);
  // Project-scoped servers drop `project_id` from tool inputs, and reject it
  // if sent, so the view passes it on only when the call had one.
  const projectId = inputText('project_id');
  const target = projectId ? { project_id: projectId } : {};

  const targetOf = (
    src: QuerySource,
    { iso_timestamp_start: s, iso_timestamp_end: e }: LogWindow
  ) => (src === 'logs' ? `logs ${s ?? ''} ${e ?? ''}` : 'database');

  const delivered: QueryRun =
    toolCall.status === 'loading'
      ? { status: 'running' }
      : toolCall.status === 'ready'
        ? {
            status: 'done',
            rows: toolCall.data.rows,
            truncated: toolCall.data.truncated,
            sql: sql ?? '',
            target: targetOf(openedSource, openedWindow),
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
      ref={editor}
      title={title}
      sql={sql}
      delivered={delivered}
      onRun={onRun}
      source={source}
      target={targetOf(source, window)}
      footerDetail={footerDetail}
      onStateChange={handleStateChange}
      onExpand={expand}
    />
  );
}
