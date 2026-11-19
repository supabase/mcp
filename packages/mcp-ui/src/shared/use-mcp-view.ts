import type {
  App,
  McpUiHostCapabilities,
  McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { useApp } from '@modelcontextprotocol/ext-apps/react';
import { useEffect, useState } from 'react';
import { parseToolError, parseToolResult } from './tool-result';
import { useHostStyles } from './use-host-styles';

export type ToolCallState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'cancelled'; reason?: string }
  /** The tool call returned an error, or the view couldn't read its result. */
  | { status: 'error'; message: string };

export type McpView<T> = {
  toolCall: ToolCallState<T>;
  /** The connected app, `null` until the host handshake completes. */
  app: App | null;
  /** Arguments of the tool call the view was opened for, once received. */
  input: Record<string, unknown> | undefined;
  hostContext: McpUiHostContext | undefined;
  /**
   * What the host supports, once connected (empty until then). Views need
   * `serverTools` to poll or fetch, and `openLinks` to open links.
   */
  hostCapabilities: McpUiHostCapabilities;
  /** Dashboard base URL the server links to, from the tool result's `_meta`. */
  dashboardUrl: string;
};

/**
 * Connects a view to its host. Returns the state of the tool call the view
 * was opened for (its parsed result once it arrives), the app, the tool input
 * the host context and capabilities. Also applies the host's styles (see `useHostStyles`).
 */
export function useMcpView<T>(name: string): McpView<T> {
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
          setToolCall({ status: 'error', message: parseToolError(result) });
          return;
        }
        try {
          setToolCall({ status: 'ready', data: parseToolResult<T>(result) });
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

  return {
    toolCall: error ? { status: 'error', message: error.message } : toolCall,
    app,
    input,
    hostContext,
    hostCapabilities: app?.getHostCapabilities() ?? {},
    dashboardUrl,
  };
}
