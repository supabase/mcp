import type { CallToolResult } from '@modelcontextprotocol/client';

const FALLBACK_ERROR = 'The tool call failed.';

/** `value` trimmed, when it is a string with something in it. */
const knownMessage = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * The message and machine-readable code of an `isError` tool result.
 *
 * The message is `error.message` or `message` from a JSON body, otherwise the
 * plain text itself (the common case: the server turns a thrown error into
 * text), read from the first non-blank text part and trimmed. It falls back to
 * a generic message if there is nothing usable.
 *
 * The code is `error.code` in a JSON body (a `ToolCallerError` with a `code`
 * on the server). Undefined when the server sent none.
 */
export function readToolError(result: CallToolResult): {
  message: string;
  code?: string;
} {
  const text = result.content
    .flatMap((part) => (part.type === 'text' ? [part.text.trim()] : []))
    .find(Boolean);
  if (!text) return { message: FALLBACK_ERROR };

  try {
    const parsed = JSON.parse(text);
    const code = parsed?.error?.code;
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    return {
      message: knownMessage(message) ?? knownMessage(parsed) ?? FALLBACK_ERROR,
      code: typeof code === 'string' && code ? code : undefined,
    };
  } catch {
    return { message: text };
  }
}

/**
 * Parses the JSON text from a successful tool result. For an `isError`
 * result, use `readToolError`.
 *
 * TODO: read `structuredContent` once the server sends it (AI-847, AI-1364).
 */
export function parseToolResult<T>(result: CallToolResult): T {
  const [first] = result.content;
  if (!first || first.type !== 'text') {
    throw new Error('Tool result has no text content');
  }

  return JSON.parse(first.text) as T;
}

/**
 * The `_meta` key a tool result carries its view's data under, which the
 * model does not read. `VIEW_DATA_META_KEY` in mcp-server-supabase
 * `src/apps/index.ts`; the view cannot import server code at run time.
 */
export const VIEW_DATA_META_KEY = 'supabase.com/view';

/**
 * The view's data from a successful tool result: `_meta[VIEW_DATA_META_KEY]`,
 * `undefined` when the server sent none (an older server, or a host that
 * strips `_meta`). The text is for the model, so it is never read as data.
 * The caller validates it.
 */
export function readViewData(result: CallToolResult): unknown {
  return result._meta?.[VIEW_DATA_META_KEY];
}
