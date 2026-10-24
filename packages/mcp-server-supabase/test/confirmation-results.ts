import { expect } from 'vitest';

/**
 * Cancel message for each confirmation tool (AI-1328). One text for every
 * cancel, whatever its timing.
 */
export const cancelledMessage = {
  execute_sql:
    "The SQL was not run. If you didn't see a confirmation prompt, your client may have cancelled it automatically.",
  apply_migration:
    "The migration was not applied. If you didn't see a confirmation prompt, your client may have cancelled it automatically.",
  run_notebook:
    "The notebook was not run. If you didn't see a confirmation prompt, your client may have cancelled it automatically.",
  create_project:
    "The project was not created. If you didn't see a confirmation prompt, your client may have cancelled it automatically.",
  create_branch:
    "The branch was not created. If you didn't see a confirmation prompt, your client may have cancelled it automatically.",
} as const;

/**
 * Asserts a terminal confirmation result (decline, cancel, or a state error):
 * `structuredContent` is `{ status, message }` and `content` is exactly one
 * text block holding that object's JSON. Errors set `isError`; decline and
 * cancel don't.
 *
 * Regression: the two channels drift apart, so a client that reads only one
 * of them (Claude Code showed just `{"status":"cancelled"}`) loses the message.
 */
export function expectTerminalResult(
  result: { structuredContent?: unknown; content?: unknown; isError?: unknown },
  status: 'declined' | 'cancelled' | 'error',
  message: string
) {
  const { structuredContent, content, isError } = result;
  expect(structuredContent).toEqual({ status, message });
  expect(content).toEqual([
    { type: 'text', text: JSON.stringify(structuredContent) },
  ]);
  if (status === 'error') expect(isError).toBe(true);
  else expect(isError).not.toBe(true);
}
