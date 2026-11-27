/**
 * View tools: tools a view registers with its host, for the model to call.
 *
 * This file is the only vendor-specific runtime code in the views. It picks
 * its paths by feature detection alone: it never checks the host's name and
 * never touches `window.openai`.
 *
 * SDK 2.1.0 of `@modelcontextprotocol/ext-apps` mirrors `app.registerTool`
 * to WebMCP itself. When upgrading to it, delete the WebMCP bridge here, or
 * each tool is registered with WebMCP twice.
 */
import type { App } from '@modelcontextprotocol/ext-apps';

/** A view tool. It takes no input. */
export type ViewTool = {
  name: string;
  /** Hosts may show the model only the first line, so it must stand alone. */
  description: string;
  /**
   * Written once: both registrations call it. Returns the text the model
   * sees, and throws to report failure; the error's message is what the
   * model sees then.
   */
  handler: () => Promise<string>;
};

/** Disables a view tool everywhere it was registered. */
export type ViewToolHandle = { disable: () => void };

/**
 * Registers `tool` with the host the MCP Apps way (`app.registerTool`), and
 * with WebMCP (`document.modelContext`) where the browser has it. Call it
 * before the view connects: the handshake then declares the tools
 * capability. Views give their tools to `useMcpView`, which calls this.
 */
export function registerViewTool(app: App, tool: ViewTool): ViewToolHandle {
  const registered = app.registerTool(
    tool.name,
    { description: tool.description },
    async () => {
      try {
        return { content: [{ type: 'text', text: await tool.handler() }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          isError: true,
        };
      }
    }
  );
  const unregisterWebMcp = registerWithWebMcp(tool);
  return {
    disable: () => {
      registered.disable();
      unregisterWebMcp?.();
    },
  };
}

/**
 * The WebMCP part: `document.modelContext.registerTool(tool, { signal })`.
 * Aborting the signal removes the tool. WebMCP reports most registration
 * failures (such as a duplicate name) by rejecting, and a missing or throwing
 * API is possible too; neither is allowed to affect the MCP Apps
 * registration. Returns how to unregister, or undefined when the browser has
 * no WebMCP or registering threw.
 */
function registerWithWebMcp(tool: ViewTool): (() => void) | undefined {
  const modelContext = (document as { modelContext?: WebMcpModelContext })
    .modelContext;
  if (typeof modelContext?.registerTool !== 'function') return undefined;

  const abort = new AbortController();
  try {
    const registration = modelContext.registerTool(
      {
        name: tool.name,
        description: tool.description,
        inputSchema: { type: 'object', properties: {} },
        execute: () => tool.handler(),
      },
      { signal: abort.signal }
    );
    Promise.resolve(registration).catch(() => {});
  } catch {
    return undefined;
  }

  return () => abort.abort();
}

/** The part of WebMCP's `ModelContext` this file uses. */
type WebMcpModelContext = {
  registerTool?: (
    tool: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      execute: (
        input: object,
        options: { signal: AbortSignal }
      ) => Promise<unknown>;
    },
    options?: { signal?: AbortSignal }
  ) => Promise<undefined> | undefined;
};
