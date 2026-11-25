import './logs-view.css';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { Admonition } from './Admonition';
import {
  CheckIcon,
  CopyIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  SpinnerIcon,
  XIcon,
} from './icons';
import {
  filterLogEntries,
  formatLogTime,
  LOG_SOURCE_LABELS,
  logSelectionText,
  selectLogRows,
  toLogEntries,
  type LogEntry,
  type LogLevelFilter,
} from './logs-model';
import { Select } from './Select';
import type { Row } from './sql-result';

export type LogSettings = {
  search: string;
  level: LogLevelFilter;
  source: string;
  minutes: 60 | 360 | 1440;
};

/** The events the host read for the settings, or where that read is. */
export type LoadedLogs =
  | { status: 'loading' }
  | {
      status: 'success';
      rows: Row[];
      /** The window the events were read from, when known. */
      window?: { start: string; end: string };
    }
  | { status: 'error'; message: string };

const LEVEL_OPTIONS = [
  { value: 'all', label: 'All levels' },
  { value: 'error', label: 'Errors' },
  { value: 'warning', label: 'Warnings' },
  { value: 'info', label: 'Info' },
];

const SOURCE_OPTIONS = [
  { value: 'all', label: 'All sources' },
  { value: 'edge_functions', label: 'Edge Functions' },
  ...Object.entries(LOG_SOURCE_LABELS).map(([value, label]) => ({
    value,
    label,
  })),
];

const MINUTE_OPTIONS = [
  { value: '60', label: 'Last hour' },
  { value: '360', label: 'Last 6 hours' },
  { value: '1440', label: 'Last 24 hours' },
];

function emptyMessage(search: string, level: LogLevelFilter) {
  if (search) return `No loaded logs match “${search}”.`;
  if (level === 'all') return 'No logs in the selected time range.';
  return `No ${level} logs in the selected time range.`;
}

function detailFields(log: LogEntry) {
  return [
    ['Time', log.time],
    ['Source', log.source],
    ['Level', log.level.toLowerCase()],
    ['Status', log.status],
    ['Method', log.method],
    ['Path', log.path],
    ['Message', log.message],
  ].filter(([, value]) => value !== '');
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A tiny text icon button with its label on hover, as the surfaces' toolbar actions. */
function ToolbarAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-slot="action"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** One or more selected events, in a panel inset beside (or below) the list. */
function LogDetailPanel({
  logs,
  agentName,
  onSend,
  onClose,
}: {
  logs: LogEntry[];
  agentName: string;
  onSend?: () => Promise<void>;
  onClose: () => void;
}) {
  const isSingle = logs.length === 1;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle'
  );
  const [isSending, setIsSending] = useState(false);

  // Hosts may have no toast, so the button confirms the copy for a moment.
  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  function handleCopy() {
    const text = JSON.stringify(
      isSingle ? logs[0]!.raw : logs.map(({ raw }) => raw),
      null,
      2
    );
    navigator.clipboard.writeText(text).then(
      () => setCopyState('copied'),
      () => setCopyState('failed')
    );
  }

  return (
    <aside data-slot="detail" aria-label="Log details">
      <header data-slot="detail-header">
        <h2 data-slot="detail-title">
          {isSingle ? logs[0]!.source : `${logs.length} logs`}
        </h2>
        <ToolbarAction
          label={
            copyState === 'copied'
              ? 'Copied'
              : copyState === 'failed'
                ? 'Copy failed'
                : 'Copy logs as JSON'
          }
          onClick={handleCopy}
        >
          {copyState === 'copied' ? <CheckIcon /> : <CopyIcon />}
        </ToolbarAction>
        {onSend && (
          <ToolbarAction
            label={`Send to ${agentName}`}
            disabled={isSending}
            onClick={() => {
              setIsSending(true);
              void onSend().finally(() => setIsSending(false));
            }}
          >
            {isSending ? <SpinnerIcon /> : <SendIcon />}
          </ToolbarAction>
        )}
        <ToolbarAction label="Close log details" onClick={onClose}>
          <XIcon />
        </ToolbarAction>
      </header>
      <div data-slot="detail-body">
        {isSingle ? (
          <dl data-slot="detail-fields">
            {detailFields(logs[0]!).map(([key, value]) => (
              <div data-slot="detail-field" key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <pre data-slot="detail-json" aria-label="Selected log metadata">
            {JSON.stringify(
              logs.map(({ raw }) => raw),
              null,
              2
            )}
          </pre>
        )}
      </div>
    </aside>
  );
}

/**
 * Recent project logs, the logs view of the Supabase surfaces: a toolbar to
 * search the loaded events and filter by level, source and time range; a
 * list of events, selectable like files (click, ⇧ for a range, ⌘/Ctrl to
 * add, arrows to move); and the selection in a detail panel, to copy or send
 * to the agent.
 */
export function LogsView({
  settings,
  onSettingsChange,
  logs,
  onRefresh,
  onSend,
  onSelectionChange,
  agentName,
}: {
  settings: LogSettings;
  onSettingsChange: (settings: LogSettings) => void;
  logs: LoadedLogs;
  onRefresh?: () => void;
  /** Sends the selection to the agent to investigate. Omit when the host can't. */
  onSend?: (text: string) => Promise<void>;
  /** Called with the selected events whenever the selection changes. */
  onSelectionChange?: (selected: LogEntry[]) => void;
  /** Names the agent in actions, e.g. "Send to Claude". */
  agentName: string;
}) {
  const { search, level, source, minutes } = settings;
  const listRef = useRef<HTMLDivElement>(null);
  const rows = logs.status === 'success' ? logs.rows : undefined;
  const loaded = useMemo(() => (rows ? toLogEntries(rows) : undefined), [rows]);
  const visible = useMemo(
    () => (loaded ? filterLogEntries(loaded, { search, level }) : []),
    [loaded, search, level]
  );

  // Any change to what's loaded or shown starts a fresh selection.
  const selectionKey = useMemo(() => ({ logs, search }), [logs, search]);
  const [selection, setSelection] = useState({
    key: selectionKey as object,
    selected: [] as string[],
    anchor: null as string | null,
    focusId: null as string | null,
  });
  if (selection.key !== selectionKey) {
    setSelection({
      key: selectionKey,
      selected: [],
      anchor: null,
      focusId: null,
    });
  }
  const clearSelection = () =>
    setSelection({
      key: selectionKey,
      selected: [],
      anchor: null,
      focusId: null,
    });

  const chosen = useMemo(
    () => visible.filter((log) => selection.selected.includes(log.id)),
    [visible, selection.selected]
  );
  const shared = useMemo(
    () => (chosen.length ? logSelectionText(chosen) : undefined),
    [chosen]
  );
  const sharedText = shared?.status === 'ready' ? shared.text : undefined;
  const [sendError, setSendError] = useState<{
    for: unknown;
    message: string;
  }>();

  useEffect(() => {
    onSelectionChange?.(chosen);
  }, [onSelectionChange, chosen]);

  function select(
    id: string,
    modifiers: { shift?: boolean; toggle?: boolean } = {}
  ) {
    const ids = visible.map((log) => log.id);
    const next = selectLogRows(
      ids,
      selection.selected,
      selection.anchor,
      id,
      modifiers
    );
    setSelection({ key: selectionKey, ...next, focusId: id });
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) {
    const log = visible[index]!;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelection({
        key: selectionKey,
        selected: visible.map((item) => item.id),
        anchor: log.id,
        focusId: log.id,
      });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      clearSelection();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const next = Math.max(
      0,
      Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))
    );
    const row =
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[
        next
      ];
    row?.focus();
    row?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    select(visible[next]!.id, { shift: event.shiftKey });
  }

  const isLoading = logs.status === 'loading';
  const loadError = logs.status === 'error' ? logs.message : undefined;
  const tooLarge = shared?.status === 'too-large' ? shared.message : undefined;
  const visibleSendError =
    sendError && sendError.for === sharedText ? sendError.message : undefined;
  const hasFocusedRow = visible.some((log) => log.id === selection.focusId);

  return (
    <section className="logs-view" aria-label="Project logs">
      <div data-slot="toolbar">
        <div data-slot="search">
          <SearchIcon slot="search-icon" size={14} />
          <input
            aria-label="Search logs"
            placeholder="Search logs…"
            value={search}
            onChange={(event) =>
              onSettingsChange({ ...settings, search: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === 'Escape' && search) {
                event.preventDefault();
                onSettingsChange({ ...settings, search: '' });
              }
            }}
          />
          {search && (
            <button
              type="button"
              data-slot="search-clear"
              aria-label="Clear log search"
              onClick={() => onSettingsChange({ ...settings, search: '' })}
            >
              <XIcon size={14} />
            </button>
          )}
        </div>
        <Select
          size="tiny"
          label="Log level"
          value={level}
          options={LEVEL_OPTIONS}
          onChange={(value) =>
            onSettingsChange({ ...settings, level: value as LogLevelFilter })
          }
        />
        <Select
          size="tiny"
          label="Log source"
          value={source}
          options={SOURCE_OPTIONS}
          onChange={(value) => onSettingsChange({ ...settings, source: value })}
        />
        <Select
          size="tiny"
          label="Log time range"
          value={String(minutes)}
          options={MINUTE_OPTIONS}
          onChange={(value) =>
            onSettingsChange({
              ...settings,
              minutes: Number(value) as LogSettings['minutes'],
            })
          }
        />
        {onRefresh && (
          <ToolbarAction
            label="Refresh logs"
            disabled={isLoading}
            onClick={onRefresh}
          >
            <RefreshCwIcon size={14} />
          </ToolbarAction>
        )}
      </div>
      {(tooLarge || visibleSendError || loadError) && (
        <div data-slot="alerts">
          {tooLarge && (
            <Admonition
              type="warning"
              title="Selection too large"
              description={tooLarge}
            />
          )}
          {!tooLarge && visibleSendError && (
            <Admonition
              type="destructive"
              title={`Failed to send logs to ${agentName}`}
              description={visibleSendError}
            />
          )}
          {loadError && (
            <Admonition
              type="warning"
              title="Failed to load logs"
              description={`Error: ${loadError}`}
              actions={
                onRefresh && (
                  <button type="button" data-size="sm" onClick={onRefresh}>
                    Retry
                  </button>
                )
              }
            />
          )}
        </div>
      )}
      <div data-slot="body">
        <div
          ref={listRef}
          data-slot="list"
          role="listbox"
          aria-label="Log events"
          aria-multiselectable="true"
          aria-busy={isLoading}
        >
          {isLoading && (
            <p data-slot="list-message" role="status">
              Loading logs…
            </p>
          )}
          {!isLoading && visible.length === 0 && (
            <p data-slot="list-message">
              {loadError
                ? 'Logs could not be loaded.'
                : emptyMessage(search, level)}
            </p>
          )}
          {!isLoading &&
            visible.map((log, index) => {
              const isTabStop =
                log.id === selection.focusId || (!hasFocusedRow && index === 0);
              return (
                <button
                  key={log.id}
                  type="button"
                  role="option"
                  data-slot="log"
                  aria-selected={selection.selected.includes(log.id)}
                  data-level={log.level}
                  tabIndex={isTabStop ? 0 : -1}
                  onFocus={() =>
                    setSelection((current) => ({ ...current, focusId: log.id }))
                  }
                  onClick={(event) =>
                    select(log.id, {
                      shift: event.shiftKey,
                      toggle: event.metaKey || event.ctrlKey,
                    })
                  }
                  onKeyDown={(event) => handleKeyDown(event, index)}
                >
                  <span data-slot="log-dot" aria-hidden="true" />
                  <time data-slot="log-time" title={log.time}>
                    {formatLogTime(log.time)}
                  </time>
                  <span data-slot="log-source">{log.source}</span>
                  {log.method && (
                    <span data-slot="log-method">{log.method}</span>
                  )}
                  {log.status && (
                    <span data-slot="log-status">{log.status}</span>
                  )}
                  <span data-slot="log-message">{log.message}</span>
                </button>
              );
            })}
        </div>
        {chosen.length > 0 && (
          <LogDetailPanel
            logs={chosen}
            agentName={agentName}
            onSend={
              onSend && sharedText
                ? async () => {
                    setSendError(undefined);
                    try {
                      await onSend(sharedText);
                    } catch (error) {
                      setSendError({
                        for: sharedText,
                        message: errorMessage(error),
                      });
                    }
                  }
                : undefined
            }
            onClose={clearSelection}
          />
        )}
      </div>
    </section>
  );
}
