import type { App } from '@modelcontextprotocol/ext-apps';
import { describe, expect, it, vi } from 'vitest';
import { callTool, ToolCallError } from './call-tool';

type Result = Awaited<ReturnType<App['callServerTool']>>;

function fakeApp(result: unknown) {
  const callServerTool = vi.fn().mockResolvedValue(result as Result);
  return { app: { callServerTool } as unknown as App, callServerTool };
}

const text = (t: string) => ({ type: 'text' as const, text: t });

describe('callTool', () => {
  it('passes the name and arguments to the server', async () => {
    const { app, callServerTool } = fakeApp({ content: [text('{}')] });
    await callTool(app, 'get_project', { id: 'abc' });
    expect(callServerTool).toHaveBeenCalledWith({
      name: 'get_project',
      arguments: { id: 'abc' },
    });
  });

  it('returns the parsed JSON on success', async () => {
    const { app } = fakeApp({ content: [text('{"id":"abc","n":1}')] });
    await expect(callTool(app, 't', {})).resolves.toEqual({ id: 'abc', n: 1 });
  });

  it('throws the plain text of an error result', async () => {
    const { app } = fakeApp({ isError: true, content: [text('Not allowed')] });
    await expect(callTool(app, 't', {})).rejects.toThrow(
      new Error('Not allowed')
    );
  });

  it('throws the message of a JSON error body', async () => {
    const { app } = fakeApp({
      isError: true,
      content: [text('{"error":{"message":"Project not found"}}')],
    });
    await expect(callTool(app, 't', {})).rejects.toThrow('Project not found');
  });

  it("throws a ToolCallError with the server's error code", async () => {
    const { app } = fakeApp({
      isError: true,
      content: [
        text(
          '{"error":{"name":"ToolCallerError","message":"Bad cursor","code":"invalid_cursor"}}'
        ),
      ],
    });
    const error = await callTool(app, 't', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallError);
    expect(error).toMatchObject({
      message: 'Bad cursor',
      code: 'invalid_cursor',
    });
  });

  it('throws a ToolCallError without a code when the server sent none', async () => {
    const { app } = fakeApp({ isError: true, content: [text('Not allowed')] });
    const error = await callTool(app, 't', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallError);
    expect((error as ToolCallError).code).toBeUndefined();
  });

  it('throws on non-text content', async () => {
    const { app } = fakeApp({
      content: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
    });
    await expect(callTool(app, 't', {})).rejects.toThrow(/no text content/);
  });

  it('rejects when the transport fails', async () => {
    const callServerTool = vi.fn().mockRejectedValue(new Error('offline'));
    const app = { callServerTool } as unknown as App;
    await expect(callTool(app, 't', {})).rejects.toThrow('offline');
  });
});
