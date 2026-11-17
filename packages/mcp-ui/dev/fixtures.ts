import type { CallToolResult } from '@modelcontextprotocol/client';

/**
 * Canned tool calls for the mock host. Each entry is keyed by view name and
 * provides the tool input the host sends, plus a handler that answers
 * `tools/call` requests the view makes back to the server.
 */
export type Fixture = {
  toolName: string;
  input: Record<string, unknown>;
  callTool(args: Record<string, unknown>): CallToolResult;
};

export const fixtures: Record<string, Fixture> = {};
