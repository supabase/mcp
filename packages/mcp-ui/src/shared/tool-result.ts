import type { CallToolResult } from '@modelcontextprotocol/client';

/**
 * Parses the JSON text from a tool result.
 *
 * TODO: read `structuredContent` once the server sends it.
 */
export function parseToolResult<T>(result: CallToolResult): T {
  const [first] = result.content;
  if (!first || first.type !== 'text') {
    throw new Error('Tool result has no text content');
  }

  const parsed = JSON.parse(first.text);

  if (result.isError) {
    throw new Error(parsed?.error?.message ?? 'Tool call failed');
  }

  return parsed as T;
}
