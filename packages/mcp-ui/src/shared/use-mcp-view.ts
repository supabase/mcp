import type { CallToolResult } from '@modelcontextprotocol/client';
import type {
  App,
  McpUiHostCapabilities,
  McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { useApp } from '@modelcontextprotocol/ext-apps/react';
import { useEffect, useRef, useState } from 'react';
import { callTool as callServerTool, type CallTool } from './call-tool';
import { type SendMessage, sendMessage } from './send-message';
import { parseToolResult, readToolError } from './tool-result';
import { useHostStyles } from './use-host-styles';
import {
  registerViewTool,
  type ViewTool,
  type ViewToolHandle,
} from './view-tools';

export type ToolCallState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'cancelled'; reason?: string }
  /** The tool call returned an error, or the view couldn't read its result. */
  | { status: 'error'; message: string };

/**
 * Replaces what the host shares with the model about the view
 * (`ui/update-model-context`). Each update replaces the last, so send the
 * whole state each time; `{ content: [] }` clears it.
 */
export type UpdateModelContext = (
  params: Parameters<App['updateModelContext']>[0]
) => Promise<void>;

/** A view tool (see `view-tools.ts`) as the view has it in one render. */
export type McpViewTool = ViewTool & {
  /**
   * Hides the tool from the host for good: once a render says so, it is never
   * enabled again.
   */
  disabled?: boolean;
};

export type McpViewOptions<T> = {
  /**
   * The tools the model can call. Registered once, before the view connects
   * so the handshake declares them: which tools there are, and their names
   * and descriptions, are read then. Read again after every render, so a call
   * runs the `handler` of the latest render and the latest `disabled`
   * applies. A function, so it can use values the view computes after
   * `useMcpView` returns.
   */
  tools?: () => readonly McpViewTool[];
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
  /**
   * Sends a message to the assistant as the user, tidied to fit what
   * Claude accepts; rejects when it is too long or the host refuses it.
   * Undefined when the host can't receive messages from views.
   */
  sendMessage: SendMessage | undefined;
  /**
   * Shares the view's state with the model for its next turn. Undefined when
   * the host doesn't accept context updates.
   */
  updateModelContext: UpdateModelContext | undefined;
};

/**
 * Connects a view to its host. Returns the state of the tool call the view
 * was opened for (its result once it arrives, as the view's `read` option
 * reads it: the JSON text by default), the app, the tool input, the host context and
 * capabilities, and helpers built on them (`callTool`, `inputText`,
 * `openLink`, `sendMessage`, `updateModelContext`). A helper is undefined when
 * the host can't do what it does. Also registers the view's `tools` and
 * applies the host's styles (see `useHostStyles`).
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

  // `tools` as of the latest render: calls run its handlers, and a tool it
  // disables stays disabled.
  const latestTools = useRef(options.tools);
  // All of them, so disabling reaches each: `<StrictMode>` creates the app
  // twice in development.
  const registrations = useRef<{ name: string; handle: ViewToolHandle }[]>([]);
  const disabledTools = useRef(new Set<string>());
  useEffect(() => {
    latestTools.current = options.tools;
    for (const tool of options.tools?.() ?? []) {
      if (!tool.disabled || disabledTools.current.has(tool.name)) continue;
      disabledTools.current.add(tool.name);
      for (const { name, handle } of registrations.current) {
        if (name === tool.name) handle.disable();
      }
    }
  });

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
      for (const tool of latestTools.current?.() ?? []) {
        const handle = registerViewTool(app, {
          name: tool.name,
          description: tool.description,
          handler: () =>
            (
              latestTools.current?.().find(({ name }) => name === tool.name) ??
              tool
            ).handler(),
        });
        registrations.current.push({ name: tool.name, handle });
        if (disabledTools.current.has(tool.name)) handle.disable();
      }
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
    sendMessage:
      app && hostCapabilities.message
        ? (text) => sendMessage(app, text)
        : undefined,
    updateModelContext:
      app && hostCapabilities.updateModelContext
        ? async (params) => {
            await app.updateModelContext(params);
          }
        : undefined,
  };
}
