import type {
  App,
  McpUiHostCapabilities,
} from '@modelcontextprotocol/ext-apps';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readViewData, VIEW_DATA_META_KEY } from './tool-result';
import type { McpViewOptions } from './use-mcp-view';
import { useMcpView } from './use-mcp-view';

type ToolResult = Parameters<NonNullable<App['ontoolresult']>>[0];

const sdk = vi.hoisted(() => ({
  capabilities: {} as McpUiHostCapabilities,
  app: undefined as unknown as App,
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
          getHostCapabilities: () => sdk.capabilities,
          getHostContext: () => undefined,
        } as unknown as App;
        sdk.app = created;
        onAppCreated?.(created);
        setApp(created);
      }, []);
      return { app, isConnected: Boolean(app), error: null };
    },
  };
});

afterEach(() => {
  cleanup();
  sdk.capabilities = {};
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

describe('useMcpView', () => {
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
    expect(result.current.callTool).toBeUndefined();
    expect(result.current.openLink).toBeUndefined();
  });
});
