import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { useApp } from '@modelcontextprotocol/ext-apps/react';
import { useEffect, useState } from 'react';
import { parseToolResult } from './tool-result';
import { useHostStyles } from './use-host-styles';

export type ToolCallState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'cancelled'; reason?: string }
  | { status: 'error'; message: string };

export type McpView<T> = {
  toolCall: ToolCallState<T>;
  /** The connected app, `null` until the host handshake completes. */
  app: App | null;
  /** Arguments of the tool call the view was opened for, once received. */
  input: Record<string, unknown> | undefined;
  hostContext: McpUiHostContext | undefined;
};

/**
 * Connects a view to its host. Returns the state of the tool call the view
 * was opened for (its parsed result once it arrives), the app, the tool input
 * and the host context. Also applies the host's styles (see `useHostStyles`).
 */
export function useMcpView<T>(name: string): McpView<T> {
  const [toolCall, setToolCall] = useState<ToolCallState<T>>({
    status: 'loading',
  });
  const [input, setInput] = useState<Record<string, unknown>>();
  const [hostContext, setHostContext] = useState<McpUiHostContext>();

  const { app, error } = useApp({
    appInfo: { name, version: '0.0.0' },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolinput = ({ arguments: args }) => setInput(args);
      app.ontoolresult = (result) => {
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
  };
}
