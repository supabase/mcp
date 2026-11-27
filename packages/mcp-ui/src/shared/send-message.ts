import type { App } from '@modelcontextprotocol/ext-apps';

/**
 * What Claude accepts in a message a view sends with `app.sendMessage`
 * (https://claude.com/docs/connectors/building/mcp-apps/send-messages): text
 * that is not blank, at most 8,000 characters, no more than three line breaks
 * or 64 spaces or tabs in a row. Claude can refuse a message that breaks one.
 *
 * Applied to every message on every host (by `sendMessage` below), so no view
 * checks the host's name. The trimming does no harm elsewhere.
 */
export const MESSAGE_MAX_CHARS = 8000;

/**
 * Thrown when a message is too long to send, so a view can word it for what
 * the user picked.
 */
export class MessageTooLongError extends Error {
  constructor() {
    super(
      `The message is longer than the ${MESSAGE_MAX_CHARS.toLocaleString('en-US')} characters the assistant accepts.`
    );
    this.name = 'MessageTooLongError';
  }
}

/** Collapses the runs of blank lines and of spaces or tabs that Claude refuses. */
function tidyMessageText(text: string) {
  return text
    .replace(/(\r?\n){4,}/g, '\n\n\n')
    .replace(/[ \t]{65,}/g, (run) => run.slice(0, 64))
    .trim();
}

/** Sends a message to the assistant as the user (`ui/message`). */
export type SendMessage = (text: string) => Promise<void>;

/**
 * Sends `text` as a user message, tidied to fit what Claude accepts. Throws
 * when the text is blank or too long (a `MessageTooLongError`; nothing is sent
 * then, since cutting what the user chose to send would mislead the
 * assistant), when the host returns an error result, and on transport errors.
 */
export async function sendMessage(app: App, text: string): Promise<void> {
  const tidy = tidyMessageText(text);
  if (!tidy) throw new Error('The message is empty.');
  if (tidy.length > MESSAGE_MAX_CHARS) throw new MessageTooLongError();
  const result = await app.sendMessage({
    role: 'user',
    content: [{ type: 'text', text: tidy }],
  });
  if (result.isError) {
    throw new Error('The assistant did not accept the message.');
  }
}
