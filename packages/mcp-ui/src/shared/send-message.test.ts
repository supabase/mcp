import type { App } from '@modelcontextprotocol/ext-apps';
import { describe, expect, it, vi } from 'vitest';
import { MessageTooLongError, sendMessage } from './send-message';

function fakeApp(result: unknown = {}) {
  const send = vi.fn().mockResolvedValue(result);
  return { app: { sendMessage: send } as unknown as App, send };
}

describe('sendMessage', () => {
  it('sends the tidied text as one user text block', async () => {
    const { app, send } = fakeApp();
    await sendMessage(app, '  Review\n\n\n\n\nthese  ');
    expect(send).toHaveBeenCalledWith({
      role: 'user',
      content: [{ type: 'text', text: 'Review\n\n\nthese' }],
    });
  });

  it('collapses more than three line breaks in a row to three', async () => {
    const { app, send } = fakeApp();
    await sendMessage(app, 'a\n\n\n\n\n\nb');
    await sendMessage(app, 'a\r\n\r\n\r\n\r\nb');
    expect(send.mock.calls.map(([message]) => message.content[0].text)).toEqual(
      ['a\n\n\nb', 'a\n\n\nb']
    );
  });

  it('cuts runs of spaces or tabs to 64', async () => {
    const { app, send } = fakeApp();
    await sendMessage(app, `a${' '.repeat(200)}b`);
    await sendMessage(app, `a${'\t'.repeat(65)}b`);
    expect(send.mock.calls.map(([message]) => message.content[0].text)).toEqual(
      [`a${' '.repeat(64)}b`, `a${'\t'.repeat(64)}b`]
    );
  });

  it('accepts 8,000 characters', async () => {
    const { app, send } = fakeApp();
    await sendMessage(app, 'a'.repeat(8000));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('throws without sending when the text is too long', async () => {
    const { app, send } = fakeApp();
    await expect(sendMessage(app, 'a'.repeat(8001))).rejects.toThrow(
      MessageTooLongError
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('measures the text after trimming', async () => {
    const { app, send } = fakeApp();
    await sendMessage(app, `${'a'.repeat(7000)}${' '.repeat(2000)}b`);
    expect(send.mock.lastCall?.[0].content[0].text).toHaveLength(7065);
  });

  it('throws without sending when the text is blank', async () => {
    const { app, send } = fakeApp();
    await expect(sendMessage(app, ' \n ')).rejects.toThrow('empty');
    expect(send).not.toHaveBeenCalled();
  });

  it('throws when the host returns an error result', async () => {
    const { app } = fakeApp({ isError: true });
    await expect(sendMessage(app, 'hi')).rejects.toThrow(
      'The assistant did not accept the message.'
    );
  });

  it('rejects when the transport fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'));
    const app = { sendMessage: send } as unknown as App;
    await expect(sendMessage(app, 'hi')).rejects.toThrow('offline');
  });
});
