import type {
  App,
  McpUiHostCapabilities,
} from '@modelcontextprotocol/ext-apps';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readViewData, VIEW_DATA_META_KEY } from './tool-result';
import type { McpViewOptions, McpViewTool } from './use-mcp-view';
import { useMcpView } from './use-mcp-view';

type ToolResult = Parameters<NonNullable<App['ontoolresult']>>[0];

const sdk = vi.hoisted(() => ({
  capabilities: {} as McpUiHostCapabilities,
  /** What happened to the fake app, in order. */
  log: [] as string[],
  app: undefined as unknown as App,
  /** Every app created, in order. */
  apps: [] as App[],
}));

// Creates the fake app, calls `onAppCreated`, then "connects" on the next
// effect, as the SDK's `useApp` does.
vi.mock('@modelcontextprotocol/ext-apps/react', async () => {
  const { useEffect, useState } = await import('react');
  return {
    useHostStyles: () => {},
    useApp: ({ onAppCreated }: { onAppCreated?: (app: App) => void }) => {
      const [app, setApp] = useState<App | null>(null);
      useEffect(() => {
        const created = {
          registerTool: vi.fn((name: string) => {
            sdk.log.push(`registered ${name}`);
            return { disable: vi.fn() };
          }),
          getHostCapabilities: () => sdk.capabilities,
          getHostContext: () => undefined,
          sendMessage: vi.fn().mockResolvedValue({}),
          updateModelContext: vi.fn().mockResolvedValue({}),
        } as unknown as App;
        sdk.app = created;
        sdk.apps.push(created);
        onAppCreated?.(created);
        sdk.log.push('connected');
        setApp(created);
      }, []);
      return { app, isConnected: Boolean(app), error: null };
    },
  };
});

afterEach(() => {
  cleanup();
  sdk.capabilities = {};
  sdk.log = [];
  sdk.apps = [];
});

function view(
  capabilities: McpUiHostCapabilities = {},
  options: McpViewOptions<unknown> = {}
) {
  sdk.capabilities = capabilities;
  return renderHook(() => useMcpView<unknown>('test-view', options));
}

const deliver = (result: ToolResult) =>
  act(() => sdk.app.ontoolresult?.(result));

/** A view whose one tool, as of each render, is `test_tool` with these props. */
function viewWithTool(initialProps: Omit<McpViewTool, 'name' | 'description'>) {
  const hook = renderHook(
    (props) =>
      useMcpView<unknown>('test-view', {
        tools: () => [
          { name: 'test_tool', description: 'The test tool.', ...props },
        ],
      }),
    { initialProps }
  );
  const registerTool = vi.mocked(sdk.app.registerTool);
  return {
    ...hook,
    registerTool,
    /** The model calls the tool, through the app. */
    call: () => (registerTool.mock.calls[0]![2] as () => Promise<unknown>)(),
    /** The app registration's `disable`. */
    disable: () => registerTool.mock.results[0]!.value.disable,
  };
}

const text = (value: string) => async () => value;

describe('useMcpView', () => {
  it('registers its tools once, before connecting', () => {
    const tools = () =>
      ['first_tool', 'second_tool'].map((name) => ({
        name,
        description: `The ${name}.`,
        handler: text('Done.'),
      }));
    const { rerender } = view({}, { tools });
    rerender();
    expect(sdk.log).toEqual([
      'registered first_tool',
      'registered second_tool',
      'connected',
    ]);
    expect(sdk.app.registerTool).toHaveBeenCalledWith(
      'first_tool',
      { description: 'The first_tool.' },
      expect.any(Function)
    );
  });

  it("calls the latest render's handler", async () => {
    const { rerender, call, registerTool } = viewWithTool({
      handler: text('First.'),
    });
    await expect(call()).resolves.toEqual({
      content: [{ type: 'text', text: 'First.' }],
    });

    rerender({ handler: text('Second.') });
    await expect(call()).resolves.toEqual({
      content: [{ type: 'text', text: 'Second.' }],
    });
    rerender({
      handler: async () => {
        throw new Error('Cannot.');
      },
    });
    await expect(call()).resolves.toEqual({
      content: [{ type: 'text', text: 'Cannot.' }],
      isError: true,
    });
    expect(registerTool).toHaveBeenCalledTimes(1);
  });

  it('disables a tool once a render says so, for good', () => {
    const { rerender, disable } = viewWithTool({ handler: text('Done.') });
    expect(disable()).not.toHaveBeenCalled();

    rerender({ handler: text('Done.'), disabled: true });
    expect(disable()).toHaveBeenCalledTimes(1);

    rerender({ handler: text('Done.'), disabled: true });
    rerender({ handler: text('Done.'), disabled: false });
    expect(disable()).toHaveBeenCalledTimes(1);
  });

  it('disables it on each app, as <StrictMode> creates two in development', () => {
    const { rerender } = renderHook(
      ({ disabled }) =>
        useMcpView<unknown>('test-view', {
          tools: () => [
            {
              name: 'test_tool',
              description: 'The test tool.',
              handler: text('Done.'),
              disabled,
            },
          ],
        }),
      { initialProps: { disabled: false }, reactStrictMode: true }
    );
    const handles = sdk.apps.map(
      (app) => vi.mocked(app.registerTool).mock.results[0]!.value
    );
    expect(handles).toHaveLength(2);

    rerender({ disabled: true });
    for (const handle of handles)
      expect(handle.disable).toHaveBeenCalledTimes(1);
  });

  it('registers no tools for a view that declares none', () => {
    view();
    expect(sdk.app.registerTool).not.toHaveBeenCalled();
    expect(sdk.log).toEqual(['connected']);
  });

  it('reads the JSON text by default', () => {
    const { result } = view();
    deliver({ content: [{ type: 'text', text: '{"id":"abc"}' }] });
    expect(result.current.toolCall).toEqual({
      status: 'ready',
      data: { id: 'abc' },
    });
  });

  it('ignores _meta view data by default', () => {
    const { result } = view();
    deliver({
      content: [{ type: 'text', text: '{"id":"abc"}' }],
      _meta: { [VIEW_DATA_META_KEY]: { page: 1 } },
    });
    expect(result.current.toolCall).toEqual({
      status: 'ready',
      data: { id: 'abc' },
    });
  });

  it('uses the reader it is given', () => {
    const { result } = view({}, { read: readViewData });
    deliver({
      content: [{ type: 'text', text: 'Opened the issues view.' }],
      _meta: { [VIEW_DATA_META_KEY]: { page: 1 } },
    });
    expect(result.current.toolCall).toEqual({
      status: 'ready',
      data: { page: 1 },
    });
  });

  it('does not parse prose as JSON when a view-data result has no _meta', () => {
    const { result } = view({}, { read: readViewData });
    deliver({
      content: [{ type: 'text', text: 'Opened the issues view for the user.' }],
    });
    expect(result.current.toolCall).toEqual({
      status: 'ready',
      data: undefined,
    });
  });

  it('turns an error from the reader into the error state', () => {
    const { result } = view(
      {},
      {
        read: () => {
          throw new Error('Unreadable.');
        },
      }
    );
    deliver({ content: [{ type: 'text', text: 'x' }] });
    expect(result.current.toolCall).toEqual({
      status: 'error',
      message: 'Error: Unreadable.',
    });
  });

  it('offers no host actions the host lacks', () => {
    const { result } = view({});
    expect(result.current.app).not.toBeNull();
    expect(result.current.sendMessage).toBeUndefined();
    expect(result.current.updateModelContext).toBeUndefined();
    expect(result.current.callTool).toBeUndefined();
    expect(result.current.openLink).toBeUndefined();
  });

  it('sends messages through the message limits when the host takes them', async () => {
    const { result } = view({ message: { text: {} } });
    await result.current.sendMessage?.('Review\n\n\n\n\nthese');
    expect(sdk.app.sendMessage).toHaveBeenCalledWith({
      role: 'user',
      content: [{ type: 'text', text: 'Review\n\n\nthese' }],
    });
    await expect(
      result.current.sendMessage?.('a'.repeat(8001))
    ).rejects.toThrow(/8,000/);
  });

  it('updates the model context when the host accepts it', async () => {
    const { result } = view({ updateModelContext: { text: {} } });
    const params = { content: [{ type: 'text' as const, text: 'Selected' }] };
    await expect(result.current.updateModelContext?.(params)).resolves.toBe(
      undefined
    );
    expect(sdk.app.updateModelContext).toHaveBeenCalledWith(params);
  });
});
