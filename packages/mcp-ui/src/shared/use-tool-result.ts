import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { useState } from 'react';
import { parseToolResult } from './tool-result';

export type ToolResultState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'cancelled'; reason?: string }
  | { status: 'error'; message: string };

/**
 * Connects a view to its host and returns the parsed result of the tool call
 * the view was opened for. Also applies the host's theme (`data-theme`,
 * `color-scheme`), which the Supabase styles key on.
 */
export function useToolResult<T>(name: string): ToolResultState<T> {
  const [state, setState] = useState<ToolResultState<T>>({
    status: 'loading',
  });

  const { app, error } = useApp({
    appInfo: { name, version: '0.0.0' },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolresult = (result) => {
        try {
          setState({ status: 'ready', data: parseToolResult<T>(result) });
        } catch (err) {
          setState({ status: 'error', message: String(err) });
        }
      };
      // Without this, a cancelled call (by the user or host) would leave the
      // view loading forever.
      app.ontoolcancelled = ({ reason }) => {
        setState({ status: 'cancelled', reason });
      };
    },
  });

  useHostStyles(app, app?.getHostContext());

  return error ? { status: 'error', message: error.message } : state;
}
