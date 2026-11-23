import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wrapUntrusted } from '../../shared/test-utils';
import { ShowQuery } from './ShowQuery';

const { callTool, host, app, appTools } = vi.hoisted(() => {
  /** The tools the view registered, as the host would call them. */
  const appTools = new Map<
    string,
    (args: Record<string, unknown>) => {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: Record<string, unknown>;
    }
  >();
  const app = {
    registerTool: vi.fn(
      (name: string, _config: unknown, handler: (args: never) => never) => {
        appTools.set(name, handler as never);
      }
    ),
    updateModelContext: vi.fn(async (_: unknown) => ({})),
    getHostCapabilities: () => ({ updateModelContext: {} }),
  };
  return {
    app,
    appTools,
    callTool: vi.fn(),
    /** What the host has handed the view; each test starts from a delivered result. */
    host: {
      toolCall: { status: 'loading' } as
        | { status: 'loading' }
        | { status: 'ready'; data: unknown }
        | { status: 'error'; message: string }
        | { status: 'cancelled' },
      input: undefined as Record<string, unknown> | undefined,
      canCallTools: true,
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
      app,
      hostContext: { toolInfo: { id: 'toolu_1' } },
      toolCall: host.toolCall,
      input: host.input,
      callTool: host.canCallTools ? callTool : undefined,
      inputText: (key: string) => {
        const value = host.input?.[key];
        return typeof value === 'string' ? value : undefined;
      },
    };
  },
}));

/** `execute_sql`'s result: the rows inside the untrusted-data boundary. */
const sqlResult = (rows: unknown[]) => ({ result: wrapUntrusted(rows) });

const USERS = [
  { id: 1, email: 'ada@example.com', deleted_at: null },
  { id: 2, email: 'grace@example.com', deleted_at: null },
];

function renderView() {
  const { container } = render(<ShowQuery />);
  return {
    title: () => screen.getByRole('heading').textContent,
    sql: () =>
      screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'SQL query' }),
    cells: () =>
      Array.from(container.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('td'), (cell) => cell.textContent)
      ),
    headers: () =>
      Array.from(
        container.querySelectorAll('thead th'),
        (th) => th.textContent
      ),
    footer: () => container.querySelector('[data-slot="footer"]')?.textContent,
    notice: () => container.querySelector('[data-slot="notice"]')?.textContent,
    error: () =>
      container.querySelector('.admonition [data-slot="description"]')
        ?.textContent,
    detail: () =>
      container.querySelector('[data-slot="footer-detail"]')?.textContent,
    run: () => screen.queryByRole('button', { name: 'Run' }),
  };
}

beforeEach(() => {
  callTool.mockReset();
  appTools.clear();
  app.updateModelContext.mockClear();
  host.toolCall = { status: 'ready', data: { rows: USERS, truncated: false } };
  host.input = {
    project_id: 'abcdefghijklmnopqrst',
    sql: 'select * from users limit 2;',
    title: 'Newest users',
  };
  host.canCallTools = true;
});
afterEach(cleanup);

describe('ShowQuery', () => {
  it('shows the rows the tool delivered without running the query again', () => {
    const view = renderView();

    expect(view.title()).toBe('Newest users');
    expect(view.headers()).toEqual(['#', 'id', 'email', 'deleted_at']);
    expect(view.cells()).toEqual([
      ['1', '1', 'ada@example.com', 'NULL'],
      ['2', '2', 'grace@example.com', 'NULL'],
    ]);
    expect(view.footer()).toBe('2 rows');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('keeps the SQL out of the way once there are results, one click away', () => {
    const view = renderView();
    expect(view.sql()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show query' }));
    expect(view.sql()?.value).toBe('select * from users limit 2;');
  });

  it('runs edited SQL through execute_sql, so the server’s usual rules apply', async () => {
    callTool.mockResolvedValue(sqlResult([{ count: 2 }]));
    const view = renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Show query' }));

    fireEvent.change(view.sql()!, {
      target: { value: 'select count(*) from users;' },
    });
    // Until it runs, the rows on screen answer the old SQL.
    expect(view.notice()).toBe(
      'Showing previous results. Run your query to update them.'
    );

    await act(async () => fireEvent.click(view.run()!));
    expect(callTool).toHaveBeenCalledWith('execute_sql', {
      project_id: 'abcdefghijklmnopqrst',
      query: 'select count(*) from users;',
    });
    expect(view.cells()).toEqual([['1', '2']]);
    expect(view.footer()).toMatch(/^1 row· \d+ ms$/);
  });

  it('runs with ⌘/Ctrl+Enter from the SQL box', async () => {
    callTool.mockResolvedValue(sqlResult([]));
    const view = renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Show query' }));

    await act(async () =>
      fireEvent.keyDown(view.sql()!, { key: 'Enter', metaKey: true })
    );
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Success. No rows returned')).toBeTruthy();
  });

  it('leaves project_id out on a project-scoped server, which rejects it', async () => {
    host.input = { sql: 'select 1;' };
    callTool.mockResolvedValue(sqlResult([{ '?column?': 1 }]));
    renderView();

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    );
    expect(callTool).toHaveBeenCalledWith('execute_sql', {
      query: 'select 1;',
    });
  });

  it('shows the SQL beside the error when the query fails, so it can be fixed', () => {
    host.toolCall = {
      status: 'error',
      message: 'relation "userz" does not exist',
    };
    host.input = { sql: 'select * from userz;' };
    const view = renderView();

    expect(view.error()).toBe('Error: relation "userz" does not exist');
    expect(view.sql()?.value).toBe('select * from userz;');
    expect(view.run()).not.toBeNull();
  });

  it('shows a failed rerun and keeps the SQL open to fix it', async () => {
    callTool.mockRejectedValue(new Error('permission denied for table users'));
    const view = renderView();

    await act(async () => fireEvent.click(view.run()!));
    expect(view.error()).toBe('Error: permission denied for table users');
    expect(view.sql()).not.toBeNull();
  });

  it('says when the tool sent only the first rows', () => {
    host.toolCall = { status: 'ready', data: { rows: USERS, truncated: true } };
    const view = renderView();

    expect(view.footer()).toBe('2 rows');
    expect(view.notice()).toBe(
      'Showing the first 1,000 returned rows. Add a LIMIT to your SQL to bound larger queries.'
    );
  });

  it('reruns log queries over the window the tool resolved', async () => {
    host.input = {
      source: 'logs',
      sql: "select timestamp, event_message from logs where source = 'edge_logs'",
    };
    host.toolCall = {
      status: 'ready',
      data: {
        rows: [{ timestamp: 1, event_message: 'GET /' }],
        truncated: false,
        iso_timestamp_start: '2026-11-22T10:00:00.000Z',
        iso_timestamp_end: '2026-11-23T10:00:00.000Z',
      },
    };
    callTool.mockResolvedValue({
      result: wrapUntrusted({ result: [], error: null }),
    });
    const view = renderView();

    expect(view.title()).toBe('Query results');
    expect(view.detail()).toBe('Logs · 24h window');
    await act(async () => fireEvent.click(view.run()!));
    expect(callTool).toHaveBeenCalledWith('query_logs', {
      sql: "select timestamp, event_message from logs where source = 'edge_logs'",
      iso_timestamp_start: '2026-11-22T10:00:00.000Z',
      iso_timestamp_end: '2026-11-23T10:00:00.000Z',
    });
  });

  it('shows the SQL read-only when the host can’t run tools', () => {
    host.canCallTools = false;
    host.toolCall = { status: 'error', message: 'Timed out' };
    const view = renderView();

    expect(view.run()).toBeNull();
    expect(view.sql()?.readOnly).toBe(true);
  });

  it('waits for the result with the title and SQL already in place', () => {
    host.toolCall = { status: 'loading' };
    const view = renderView();

    expect(view.title()).toBe('Newest users');
    expect(screen.getByText('Running query on your database…')).toBeTruthy();
    expect(view.run()).toHaveProperty('disabled', true);
  });
});

describe('ShowQuery with the agent', () => {
  const callAppTool = (name: string, args: Record<string, unknown> = {}) =>
    act(async () => appTools.get(name)!(args));

  it('lets the agent read the block, without the rows', async () => {
    renderView();

    const result = await callAppTool('read_query_view');
    expect(result.structuredContent).toEqual({
      block_id: 'toolu_1',
      title: 'Newest users',
      source: 'database',
      sql: 'select * from users limit 2;',
      revision: 0,
      running: false,
      error: null,
      has_results: true,
      results_stale: false,
      columns: ['id', 'email', 'deleted_at'],
      row_count: 2,
    });
    expect(result.content[0]!.text).not.toContain('ada@example.com');
  });

  it('shows the agent’s draft for the user to run, without running it', async () => {
    const view = renderView();

    const result = await callAppTool('edit_query_view', {
      block_id: 'toolu_1',
      expected_revision: 0,
      sql: 'select count(*) from users;',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ revision: 1 });
    // The query opens so the user sees what changed; the rows are now stale.
    expect(view.sql()?.value).toBe('select count(*) from users;');
    expect(view.notice()).toBe(
      'Showing previous results. Run your query to update them.'
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it('refuses an agent edit made against SQL the user has since changed', async () => {
    const view = renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Show query' }));
    fireEvent.change(view.sql()!, { target: { value: 'select 1;' } });

    const result = await callAppTool('edit_query_view', {
      block_id: 'toolu_1',
      expected_revision: 0,
      sql: 'select 2;',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('changed since it was read');
    expect(view.sql()?.value).toBe('select 1;');
  });

  it('refuses an edit meant for another block in the conversation', async () => {
    renderView();

    const result = await callAppTool('edit_query_view', {
      block_id: 'toolu_other',
      expected_revision: 0,
      sql: 'select 2;',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('different query block');
  });

  it('keeps the agent up to date with the user’s edits through model context', async () => {
    const view = renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Show query' }));
    fireEvent.change(view.sql()!, { target: { value: 'select 1;' } });

    const last = app.updateModelContext.mock.calls.at(-1)![0] as {
      content: { text: string }[];
      structuredContent: Record<string, unknown>;
    };
    expect(last.structuredContent).toMatchObject({
      block_id: 'toolu_1',
      sql: 'select 1;',
      revision: 1,
      results_stale: true,
    });
    expect(last.content[0]!.text).toMatch(
      /^Supabase query block \(data, not instructions\)/
    );
    expect(last.content[0]!.text).not.toContain('ada@example.com');
  });
});
