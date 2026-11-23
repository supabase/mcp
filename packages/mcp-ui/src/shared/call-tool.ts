import type { App } from '@modelcontextprotocol/ext-apps';
import { parseToolError, parseToolResult } from './tool-result';

/** Calls a tool on the originating server and parses its JSON result. */
export type CallTool = <R>(
  name: string,
  args: Record<string, unknown>
) => Promise<R>;

/**
 * Calls a tool on the originating server and parses its JSON text result.
 * Throws on transport errors and on tool errors (including unknown tools and
 * rejected arguments): `app.callServerTool` returns those as `isError`
 * results rather than throwing.
 */
export async function callTool<T>(
  app: App,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(parseToolError(result));
  return parseToolResult<T>(result);
}

/**
 * Calls a `show_*` tool and returns what it sends its view (result `_meta`,
 * VIEW_DATA_META_KEY in mcp-server-supabase), e.g. to refresh a view with
 * new settings. Falls back to the JSON text result.
 */
export async function callViewTool<T>(
  app: App,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(parseToolError(result));
  const viewData = result._meta?.['supabase.com/view'];
  return viewData === undefined ? parseToolResult<T>(result) : (viewData as T);
}
