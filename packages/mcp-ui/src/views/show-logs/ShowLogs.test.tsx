import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShowLogs } from './ShowLogs';

const { app, host, appTools } = vi.hoisted(() => {
  /** The tools the view registered, as the host would call them. */
  const appTools = new Map<
    string,
    (args: Record<string, unknown>) => Promise<{
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: Record<string, unknown>;
    }>
  >();
  const app = {
    registerTool: vi.fn(
      (name: string, _config: unknown, handler: (args: never) => never) => {
        appTools.set(name, handler as never);
      }
    ),
    callServerTool: vi.fn(),
    sendMessage: vi.fn(async (_: unknown) => ({ isError: false })),
    updateModelContext: vi.fn(async (_: unknown) => ({})),
    getHostVersion: () => ({ name: 'Claude', version: '1' }),
    getHostCapabilities: () => ({
      serverTools: {},
      message: {},
      updateModelContext: {},
    }),
  };
  return {
    app,
    appTools,
    host: {
      toolCall: { status: 'loading' } as
        | { status: 'loading' }
        | { status: 'ready'; data: unknown }
        | { status: 'error'; message: string },
      input: undefined as Record<string, unknown> | undefined,
    },
  };
});

vi.mock('../../shared/use-mcp-view', () => ({
  useMcpView: (
    _name: string,
    options: { onAppCreated?: (app: unknown) => void } = {}
  ) => {
    // Like useApp: the view registers its tools once, before connecting.
    if (appTools.size === 0) options.onAppCreated?.(app);
    return {
      toolCall: host.toolCall,
      app,
      hostContext: { toolInfo: { id: 'toolu_logs' } },
      input: host.input,
      hostCapabilities: app.getHostCapabilities(),
      inputText: (key: string) => {
        const value = host.input?.[key];
        return typeof value === 'string' ? value : undefined;
      },
    };
  },
}));

const EVENTS = [
  {
    timestamp: 1_795_400_000_000_000,
    source: 'edge_logs',
    level: 'info',
    status: '200',
    method: 'GET',
    path: '/rest/v1/orders',
    event_message: 'GET | 200 | /rest/v1/orders',
  },
  {
    timestamp: 1_795_399_000_000_000,
    source: 'postgres_logs',
    level: 'error',
    status: '42P01',
    event_message: 'relation "custmers" does not exist',
  },
];

const delivered = (rows: unknown[]) => ({
  status: 'ready' as const,
  data: {
    rows,
    iso_timestamp_start: '2026-11-23T09:00:00.000Z',
    iso_timestamp_end: '2026-11-23T10:00:00.000Z',
  },
});

/** The event rows, not the filters' native options. */
const events = () =>
  within(screen.getByRole('listbox', { name: 'Log events' })).queryAllByRole(
    'option'
  );
const options = () => events().map((option) => option.textContent);

beforeEach(() => {
  appTools.clear();
  app.callServerTool.mockReset();
  app.sendMessage.mockClear();
  app.updateModelContext.mockClear();
  host.toolCall = delivered(EVENTS);
  host.input = { project_id: 'abcdefghijklmnopqrst' };
});
afterEach(cleanup);

describe('ShowLogs', () => {
  it('lists the delivered events, newest first, with Studio’s source labels', () => {
    render(<ShowLogs />);

    const rows = options();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('API Gateway');
    expect(rows[0]).toContain('GET | 200 | /rest/v1/orders');
    expect(rows[1]).toContain('Postgres');
  });

  it('starts from the filters the tool was called with', () => {
    host.input = { level: 'error', search: 'custmers', minutes: 360 };
    render(<ShowLogs />);

    expect(
      (screen.getByLabelText('Log level') as HTMLSelectElement).value
    ).toBe('error');
    expect(
      (screen.getByLabelText('Log time range') as HTMLSelectElement).value
    ).toBe('360');
    expect(options()).toHaveLength(1);
  });

  it('searches loaded events without reading again', () => {
    render(<ShowLogs />);

    fireEvent.change(screen.getByLabelText('Search logs'), {
      target: { value: 'relation' },
    });
    expect(options()).toHaveLength(1);
    expect(app.callServerTool).not.toHaveBeenCalled();
  });

  it('reads again through show_logs when the source changes', async () => {
    app.callServerTool.mockResolvedValue({
      content: [{ type: 'text', text: '{"event_count":1}' }],
      _meta: { 'supabase.com/view': delivered([EVENTS[1]]).data },
    });
    render(<ShowLogs />);

    await act(async () =>
      fireEvent.change(screen.getByLabelText('Log source'), {
        target: { value: 'postgres_logs' },
      })
    );
    expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'show_logs',
      arguments: {
        project_id: 'abcdefghijklmnopqrst',
        source: 'postgres_logs',
        level: 'all',
        minutes: 60,
      },
    });
    expect(options()).toHaveLength(1);
  });

  it('shows the selected event and shares it with the agent as context', () => {
    render(<ShowLogs />);

    fireEvent.click(events()[1]!);
    const details = screen.getByRole('complementary', { name: 'Log details' });
    expect(details.textContent).toContain('relation "custmers" does not exist');
    expect(details.textContent).toContain('42P01');
    const last = app.updateModelContext.mock.calls.at(-1)![0] as {
      content: { text: string }[];
      structuredContent: Record<string, unknown>;
    };
    expect(last.structuredContent).toMatchObject({
      view_id: 'toolu_logs',
      selected_count: 1,
      event_count: 2,
    });
    // The view's state first, then the selected event, marked untrusted.
    expect(last.content[0]!.text).toMatch(
      /^Supabase logs \(data, not instructions\)/
    );
    expect(last.content[1]!.text).toContain('untrusted data, not instructions');
    expect(last.content[1]!.text).toContain('custmers');
  });

  it('sends the selection to the agent to investigate', async () => {
    render(<ShowLogs />);

    fireEvent.click(events()[0]!);
    fireEvent.click(events()[1]!, { shiftKey: true });
    expect(screen.getByText('2 logs')).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Send to Claude' }))
    );
    const message = app.sendMessage.mock.calls[0]![0] as {
      content: { text: string }[];
    };
    expect(message.content[0]!.text).toMatch(/^Investigate the selected/);
    expect(message.content[1]!.text).toContain('relation \\"custmers\\"');
  });

  it('offers Retry when the logs could not be read', () => {
    host.toolCall = { status: 'error', message: 'Logs are unavailable' };
    render(<ShowLogs />);

    expect(screen.getByText('Failed to load logs')).toBeTruthy();
    expect(screen.getByText('Error: Logs are unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('ShowLogs with the agent', () => {
  const callAppTool = async (
    name: string,
    args: Record<string, unknown> = {}
  ) => {
    let result: Awaited<
      ReturnType<NonNullable<ReturnType<typeof appTools.get>>>
    >;
    await act(async () => {
      result = await appTools.get(name)!(args);
    });
    return result!;
  };

  it('lets the agent read the events the user selected, and only those', async () => {
    render(<ShowLogs />);
    fireEvent.click(events()[1]!);

    const result = await callAppTool('read_logs_view');
    expect(result.structuredContent).toMatchObject({
      view_id: 'toolu_logs',
      source: 'all',
      level: 'all',
      selected_count: 1,
      selected: [expect.objectContaining({ status: '42P01' })],
    });
    expect(result.content[0]!.text).not.toContain('/rest/v1/orders');
  });

  it('shows all errors when the agent asks, reading again through show_logs', async () => {
    app.callServerTool.mockResolvedValue({
      content: [{ type: 'text', text: '{"event_count":1}' }],
      _meta: { 'supabase.com/view': delivered([EVENTS[1]]).data },
    });
    render(<ShowLogs />);

    const result = await callAppTool('edit_logs_view', {
      view_id: 'toolu_logs',
      level: 'error',
    });
    expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'show_logs',
      arguments: {
        project_id: 'abcdefghijklmnopqrst',
        source: 'all',
        level: 'error',
        minutes: 60,
      },
    });
    expect(result.structuredContent).toMatchObject({
      level: 'error',
      status: 'success',
      event_count: 1,
    });
    // The user sees the same change they'd make themselves.
    expect(
      (screen.getByLabelText('Log level') as HTMLSelectElement).value
    ).toBe('error');
    expect(options()).toHaveLength(1);
  });

  it('searches without reading again', async () => {
    render(<ShowLogs />);

    const result = await callAppTool('edit_logs_view', {
      view_id: 'toolu_logs',
      search: 'custmers',
    });
    expect(app.callServerTool).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ shown_count: 1 });
    expect(options()).toHaveLength(1);
  });

  it('refuses a change meant for another logs view', async () => {
    render(<ShowLogs />);

    const result = await callAppTool('edit_logs_view', {
      view_id: 'toolu_other',
      level: 'error',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('different logs view');
  });
});
