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
