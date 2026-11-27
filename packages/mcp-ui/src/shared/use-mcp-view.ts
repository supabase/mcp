import type { CallToolResult } from '@modelcontextprotocol/client';
import type {
  App,
  McpUiHostCapabilities,
  McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { useApp } from '@modelcontextprotocol/ext-apps/react';
import { useEffect, useState } from 'react';
import { callTool as callServerTool, type CallTool } from './call-tool';
import { parseToolResult, readToolError } from './tool-result';
import { useHostStyles } from './use-host-styles';

export type ToolCallState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'cancelled'; reason?: string }
  /** The tool call returned an error, or the view couldn't read its result. */
  | { status: 'error'; message: string };

export type McpViewOptions<T> = {
  /**
   * Reads the view's data from the successful tool result. Defaults to the
   * JSON text (`parseToolResult`). It may throw: the message becomes the
   * `error` state. Read once, when the view mounts, so it need not be
   * stable.
   */
  read?: (result: CallToolResult) => T;
};

export type McpView<T> = {
  toolCall: ToolCallState<T>;
  /** The connected app, `null` until the host handshake completes. */
  app: App | null;
  /** Arguments of the tool call the view was opened for, once received. */
  input: Record<string, unknown> | undefined;
  hostContext: McpUiHostContext | undefined;
  /** What the host supports, once connected (empty until then). */
  hostCapabilities: McpUiHostCapabilities;
  /** Dashboard base URL the server links to, from the tool result's `_meta`. */
  dashboardUrl: string;
  /**
   * Calls a tool on the originating server; undefined until the app is
   * connected, and when the host can't proxy tool calls.
   */
  callTool: CallTool | undefined;
  /** A string argument of the tool call, if sent and a string. */
  inputText: (key: string) => string | undefined;
  /**
   * Asks the host to open a link; undefined when the host can't open links
   * (a sandboxed view can't open them itself).
   */
  openLink: ((url: string) => void) | undefined;
};

/**
 * Connects a view to its host. Returns the state of the tool call the view
 * was opened for (its result once it arrives, as the view's `read` option
 * reads it: the JSON text by default), the app, the tool input, the host context and
 * capabilities, and helpers built on them (`callTool`, `inputText`,
 * `openLink`). Also applies the host's styles (see `useHostStyles`).
 */
export function useMcpView<T>(
  name: string,
  options: McpViewOptions<T> = {}
): McpView<T> {
  const [toolCall, setToolCall] = useState<ToolCallState<T>>({
    status: 'loading',
  });
  const [input, setInput] = useState<Record<string, unknown>>();
  const [hostContext, setHostContext] = useState<McpUiHostContext>();
  // Older servers don't send it; they only link to production.
  const [dashboardUrl, setDashboardUrl] = useState(
    'https://supabase.com/dashboard'
  );

  const { app, error } = useApp({
    appInfo: { name, version: '0.0.0' },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolinput = ({ arguments: args }) => setInput(args);
      app.ontoolresult = (result) => {
        // DASHBOARD_URL_META_KEY in mcp-server-supabase `src/apps/index.ts`.
        const metaUrl = result._meta?.['supabase.com/dashboardUrl'];
        if (typeof metaUrl === 'string') setDashboardUrl(metaUrl);
        if (result.isError) {
          setToolCall({
            status: 'error',
            message: readToolError(result).message,
          });
          return;
        }
        try {
          setToolCall({
            status: 'ready',
            data: (options.read ?? parseToolResult<T>)(result),
          });
        } catch (err) {
          setToolCall({ status: 'error', message: String(err) });
        }
      };
      // Without this, a cancelled call (by the user or host) would leave the
      // view loading forever.
      app.ontoolcancelled = ({ reason }) => {
        setToolCall({ status: 'cancelled', reason });
      };
      app.onhostcontextchanged = (changed) =>
        setHostContext((current) => ({ ...current, ...changed }));
    },
  });

  useEffect(() => {
    if (app) setHostContext((current) => app.getHostContext() ?? current);
  }, [app]);

  useHostStyles(app, hostContext);

  const hostCapabilities = app?.getHostCapabilities() ?? {};
  return {
    toolCall: error ? { status: 'error', message: error.message } : toolCall,
    app,
    input,
    hostContext,
    hostCapabilities,
    dashboardUrl,
    callTool:
      app && hostCapabilities.serverTools
        ? (name, args) => callServerTool(app, name, args)
        : undefined,
    inputText: (key) => {
      const value = input?.[key];
      return typeof value === 'string' ? value : undefined;
    },
    openLink:
      app && hostCapabilities.openLinks
        ? (url) => void app.openLink({ url })
        : undefined,
  };
}
