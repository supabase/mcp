import type { App } from '@modelcontextprotocol/ext-apps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerViewTool, type ViewTool } from './view-tools';

const tool: ViewTool = {
  name: 'refresh_test_view',
  description: 'Reloads the test view.',
  handler: vi.fn(async () => 'Done.'),
};

/** A fake app: `registerTool` returns a handle whose `disable` is a spy. */
function fakeApp() {
  const registered = { disable: vi.fn() };
  const registerTool = vi.fn((..._args: unknown[]) => registered);
  return {
    app: { registerTool } as unknown as App,
    registerTool,
    registered,
    /** The callback the app was given. */
    callback: () => registerTool.mock.calls[0]![2] as () => Promise<unknown>,
  };
}

/** Gives the document a WebMCP `modelContext` for this test. */
function withModelContext(modelContext: Record<string, unknown>) {
  Object.defineProperty(document, 'modelContext', {
    value: modelContext,
    configurable: true,
  });
}

const textResult = { content: [{ type: 'text', text: 'Done.' }] };

afterEach(() => {
  delete (document as { modelContext?: unknown }).modelContext;
  vi.clearAllMocks();
});

describe('registerViewTool', () => {
  it('registers with the app only, where the browser has no WebMCP', async () => {
    const { app, registerTool, callback } = fakeApp();
    registerViewTool(app, tool);

    expect(registerTool).toHaveBeenCalledWith(
      'refresh_test_view',
      { description: 'Reloads the test view.' },
      expect.any(Function)
    );
    await expect(callback()()).resolves.toEqual(textResult);
  });

  it('registers with the app and WebMCP, both calling the one handler', async () => {
    const registerWebMcp = vi.fn();
    withModelContext({ registerTool: registerWebMcp });
    const { app, callback } = fakeApp();
    registerViewTool(app, tool);

    expect(registerWebMcp).toHaveBeenCalledTimes(1);
    const [definition] = registerWebMcp.mock.calls[0]!;
    expect(definition).toMatchObject({
      name: 'refresh_test_view',
      description: 'Reloads the test view.',
      inputSchema: { type: 'object', properties: {} },
    });
    await expect(definition.execute()).resolves.toBe('Done.');
    await expect(callback()()).resolves.toEqual(textResult);
    expect(tool.handler).toHaveBeenCalledTimes(2);
  });

  it('reports a thrown error as an error text result to the app, and rejects in WebMCP', async () => {
    const registerWebMcp = vi.fn();
    withModelContext({ registerTool: registerWebMcp });
    const boom = new Error('Could not reload.');
    const failing: ViewTool = {
      ...tool,
      handler: vi.fn(async () => {
        throw boom;
      }),
    };
    const { app, callback } = fakeApp();
    registerViewTool(app, failing);

    const [definition] = registerWebMcp.mock.calls[0]!;
    await expect(definition.execute()).rejects.toBe(boom);
    await expect(callback()()).resolves.toEqual({
      content: [{ type: 'text', text: 'Could not reload.' }],
      isError: true,
    });
  });

  it('reports a thrown non-Error to the app as its string', async () => {
    const throwing: ViewTool = {
      ...tool,
      handler: vi.fn(async () => {
        throw 'plain string';
      }),
    };
    const { app, callback } = fakeApp();
    registerViewTool(app, throwing);

    await expect(callback()()).resolves.toEqual({
      content: [{ type: 'text', text: 'plain string' }],
      isError: true,
    });
  });

  it('disables the tool in both places with one handle', () => {
    const registerWebMcp = vi.fn();
    withModelContext({ registerTool: registerWebMcp });
    const { app, registered } = fakeApp();

    const handle = registerViewTool(app, tool);
    const [, options] = registerWebMcp.mock.calls[0] as unknown as [
      unknown,
      { signal: AbortSignal },
    ];
    expect(options.signal.aborted).toBe(false);

    handle.disable();

    expect(registered.disable).toHaveBeenCalledTimes(1);
    expect(options.signal.aborted).toBe(true);
  });

  it('can be disabled more than once', () => {
    withModelContext({ registerTool: vi.fn() });
    const { app } = fakeApp();
    const handle = registerViewTool(app, tool);

    expect(() => {
      handle.disable();
      handle.disable();
    }).not.toThrow();
  });

  it('keeps the app registration when WebMCP throws', () => {
    withModelContext({
      registerTool: () => {
        throw new Error('Tool already registered');
      },
    });
    const { app, registerTool, registered } = fakeApp();

    const handle = registerViewTool(app, tool);
    expect(registerTool).toHaveBeenCalledTimes(1);
    handle.disable();
    expect(registered.disable).toHaveBeenCalledTimes(1);
  });

  it('keeps the app registration when WebMCP rejects', async () => {
    withModelContext({
      registerTool: () => Promise.reject(new Error('Tool already registered')),
    });
    const { app, registerTool, registered } = fakeApp();

    const handle = registerViewTool(app, tool);
    handle.disable();
    await Promise.resolve();

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registered.disable).toHaveBeenCalledTimes(1);
  });
});
