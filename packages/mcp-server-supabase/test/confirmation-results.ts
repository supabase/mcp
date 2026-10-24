import { expect, onTestFinished, vi } from 'vitest';

/**
 * Freeze `Date.now()` for the rest of the test, so a confirmation issued and
 * resumed inside it has a 0 ms gap and its cancel text is a fixed literal.
 */
export function freezeClock() {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  onTestFinished(() => clock.mockRestore());
}

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
