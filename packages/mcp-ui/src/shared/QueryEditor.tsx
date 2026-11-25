import './button.css';
import './query-editor.css';

import {
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { Admonition } from './Admonition';
import {
  CodeSquareIcon,
  EyeIcon,
  EyeOffIcon,
  Maximize2Icon,
  PlayIcon,
  SpinnerIcon,
} from './icons';
import { ResultsGrid } from './ResultsGrid';
import { columnsOf, type Row } from './sql-result';
import { SqlEditor } from './SqlEditor';

/** Rows a query returned, and the SQL that returned them. */
export type QueryResult = {
  rows: Row[];
  /** More rows came back than the view shows. */
  truncated: boolean;
  sql: string;
  /** How long a run from the view took. */
  elapsedMs?: number;
  /** What the SQL ran against (the editor's `target` at the time). */
  target?: string;
};

/** Where a query's run is: waiting for it, its rows, or why it failed. */
export type QueryRun =
  | { status: 'running' }
  | ({ status: 'done' } & QueryResult)
  | { status: 'error'; message: string };

/** Runs SQL for the editor and resolves with its rows. */
export type RunQuery = (
  sql: string
) => Promise<Pick<QueryResult, 'rows' | 'truncated'>>;

/**
 * What the editor shows, for the agent: the SQL and its revision, and the
 * results' shape. Never the rows: they stay with the user.
 */
export type QueryEditorState = {
  sql: string;
  /** Advances on every change to the SQL, the user's or the agent's. */
  revision: number;
  running: boolean;
  /** Why the last run failed, if it did. */
  error: string | null;
  has_results: boolean;
  /** The results answer an earlier version of the SQL, or another source. */
  results_stale: boolean;
  columns: string[];
  row_count: number | null;
};

/** What the agent can do with a mounted editor. Never runs SQL. */
export type QueryEditorHandle = {
  read(): QueryEditorState;
  /**
   * Replaces the SQL, shown but not run. Throws when the user changed it
   * since `expectedRevision` was read, or while a query is running.
   */
  update(sql: string, expectedRevision: number): { revision: number };
};

const ERROR_LIMIT = 4000;

/** Most rows a query view shows (`SHOW_QUERY_ROW_LIMIT` on the server). */
export const QUERY_RESULT_ROW_LIMIT = 1000;

/**
 * A SQL query and its results, the embedded query editor of the Supabase
 * surfaces (QueryEditor in its `embedded` variant): a toolbar with the title,
 * Show/Hide query and Run, the SQL (hidden while there are results to look
 * at), the results grid, and a footer with the row count and run time.
 *
 * `delivered` is the run the view was opened with. Once the user runs the
 * SQL, the editor shows its own runs instead.
 */
export function QueryEditor({
  title,
  sql: initialSql,
  delivered,
  onRun,
  source = 'database',
  target,
  footerDetail,
  onStateChange,
  ref,
  onExpand,
}: {
  title: string;
  /** The SQL to start from; undefined until the host sends it. */
  sql: string | undefined;
  delivered: QueryRun;
  /** Runs edited SQL. Omit when the host can't call tools: the SQL is then read-only. */
  onRun?: RunQuery;
  source?: 'database' | 'logs';
  /**
   * What the SQL runs against, e.g. the source and log window. Results run
   * against another target show as stale, like results of other SQL.
   */
  target?: string;
  /** On the footer's right, e.g. the log window, with its full text on hover. */
  footerDetail?: { label: string; title?: string };
  /** Called with what the editor shows whenever it changes, e.g. to share with the agent. */
  onStateChange?: (state: QueryEditorState) => void;
  ref?: Ref<QueryEditorHandle>;
  /** Asks the host for more room, e.g. its side panel. Omit to hide Expand. */
  onExpand?: () => Promise<void>;
}) {
  const titleId = useId();
  // The SQL as changed in the editor, and a revision that advances on every
  // change, read synchronously so back-to-back agent calls see each other.
  const draft = useRef<{ sql?: string; revision: number }>({ revision: 0 });
  const [, setDraftVersion] = useState(0);
  const [ownRun, setOwnRun] = useState<QueryRun>();
  const [isRunning, setIsRunning] = useState(false);
  const [isQueryShown, setIsQueryShown] = useState<boolean>();
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandError, setExpandError] = useState('');
  const lock = useRef(false);

  const sql = draft.current.sql ?? initialSql ?? '';
  const run = ownRun ?? delivered;
  const result = run.status === 'done' ? run : undefined;
  const isBusy = isRunning || run.status === 'running';
  const isStale =
    !!result && (result.sql !== sql || (result.target ?? target) !== target);
  // Embedded editors hide the query while there are results to look at.
  const showQuery = isQueryShown ?? run.status !== 'done';
  const canRun = !!onRun && !isBusy && sql.trim().length > 0;
  const columns = result ? columnsOf(result.rows) : [];

  /** Changes the SQL; with `expectedRevision`, only if nothing changed it since. */
  function changeSql(next: string, expectedRevision?: number) {
    const current = draft.current.sql ?? initialSql ?? '';
    if (
      expectedRevision !== undefined &&
      expectedRevision !== draft.current.revision
    ) {
      throw new Error(
        'The query changed since it was read. Read it again before proposing another edit.'
      );
    }
    if (next !== current) {
      draft.current = { sql: next, revision: draft.current.revision + 1 };
      setDraftVersion((version) => version + 1);
    }
    return { revision: draft.current.revision };
  }

  const state: QueryEditorState = {
    sql,
    revision: draft.current.revision,
    running: isBusy,
    error: run.status === 'error' ? run.message.slice(0, ERROR_LIMIT) : null,
    has_results: !!result,
    results_stale: isStale,
    columns,
    row_count: result ? result.rows.length : null,
  };
  const latest = useRef(state);
  latest.current = state;

  useImperativeHandle(ref, () => ({
    read: () => ({
      ...latest.current,
      sql: draft.current.sql ?? initialSql ?? '',
      revision: draft.current.revision,
      running: latest.current.running || lock.current,
    }),
    update(next, expectedRevision) {
      if (lock.current || latest.current.running) {
        throw new Error(
          'Wait for the running query to finish before changing the draft.'
        );
      }
      const changed = changeSql(next, expectedRevision);
      setIsQueryShown(true);
      return changed;
    },
  }));

  const stateKey = JSON.stringify(state);
  useEffect(() => {
    onStateChange?.(JSON.parse(stateKey));
  }, [onStateChange, stateKey]);

  async function handleRun() {
    const ran = sql;
    if (!onRun || lock.current || !ran.trim()) return;
    lock.current = true;
    setIsRunning(true);
    const start = performance.now();
    try {
      const next = await onRun(ran);
      setOwnRun({
        status: 'done',
        ...next,
        sql: ran,
        target,
        elapsedMs: Math.round(performance.now() - start),
      });
    } catch (error) {
      setOwnRun({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      lock.current = false;
      setIsRunning(false);
    }
  }

  async function handleExpand() {
    if (!onExpand || isExpanding) return;
    setIsExpanding(true);
    setExpandError('');
    try {
      await onExpand();
    } catch (error) {
      setExpandError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExpanding(false);
    }
  }

  return (
    <section
      className="query-editor"
      aria-labelledby={titleId}
      aria-busy={isBusy}
    >
      <div data-slot="toolbar" role="toolbar" aria-labelledby={titleId}>
        <CodeSquareIcon slot="toolbar-icon" />
        <h2 data-slot="title" id={titleId}>
          {title}
        </h2>
        <div data-slot="actions">
          <button
            type="button"
            data-slot="action"
            aria-label={showQuery ? 'Hide query' : 'Show query'}
            title={showQuery ? 'Hide query' : 'Show query'}
            onClick={() => setIsQueryShown(!showQuery)}
          >
            {showQuery ? <EyeOffIcon /> : <EyeIcon />}
          </button>
          {onExpand && (
            <button
              type="button"
              data-slot="action"
              aria-label="Expand query"
              title="Expand query"
              disabled={isExpanding}
              onClick={() => void handleExpand()}
            >
              <Maximize2Icon />
            </button>
          )}
          {onRun && (
            <button
              type="button"
              data-size="sm"
              data-slot="run"
              title="Run query (⌘↵)"
              disabled={!canRun}
              onClick={() => void handleRun()}
            >
              {isRunning ? <SpinnerIcon size={14} /> : <PlayIcon size={14} />}
              Run
            </button>
          )}
        </div>
      </div>
      {showQuery && (
        <div data-slot="editor">
          <SqlEditor
            value={sql}
            onChange={(value) => changeSql(value)}
            onRun={() => void handleRun()}
            readOnly={!onRun}
          />
        </div>
      )}
      <div data-slot="results">
        {expandError && (
          <Admonition
            type="warning"
            layout="full-bleed"
            title="Failed to open query"
            description={`Error: ${expandError}`}
          />
        )}
        {run.status === 'error' && (
          <Admonition
            type="warning"
            layout="full-bleed"
            title="Failed to run query"
            description={`Error: ${run.message}`}
          />
        )}
        {isStale && (
          <p data-slot="notice" role="status">
            Showing previous results. Run your query to update them.
          </p>
        )}
        {!result && isBusy && (
          <p data-slot="empty">
            Running query on your {source === 'logs' ? 'logs' : 'database'}…
          </p>
        )}
        {!result && !isBusy && run.status !== 'error' && (
          <p data-slot="empty">
            <PlayIcon slot="empty-icon" size={12} />
            Run the query to see results
          </p>
        )}
        {result && columns.length === 0 && (
          <p data-slot="empty">Success. No rows returned</p>
        )}
        {result && columns.length > 0 && <ResultsGrid rows={result.rows} />}
        {result?.truncated && (
          <p data-slot="notice">
            Showing the first {QUERY_RESULT_ROW_LIMIT.toLocaleString()} returned
            rows. Add a LIMIT to your SQL to bound larger queries.
          </p>
        )}
      </div>
      <div data-slot="footer">
        <p data-slot="footer-status" role="status">
          <span>
            {(result?.rows.length ?? 0).toLocaleString()}{' '}
            {result?.rows.length === 1 ? 'row' : 'rows'}
          </span>
          {isBusy && <span data-slot="footer-running">Running…</span>}
          {!isBusy && result?.elapsedMs !== undefined && (
            <span>· {result.elapsedMs} ms</span>
          )}
        </p>
        {footerDetail && (
          <span data-slot="footer-detail" title={footerDetail.title}>
            {footerDetail.label}
          </span>
        )}
      </div>
    </section>
  );
}
