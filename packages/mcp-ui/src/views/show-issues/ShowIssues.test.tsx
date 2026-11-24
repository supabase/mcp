import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectIssues } from '../../shared/IssuesList';
import { ShowIssues } from './ShowIssues';

const { app, host } = vi.hoisted(() => ({
  app: {
    sendMessage: vi.fn(),
    callServerTool: vi.fn(),
  },
  /** What the host has handed the view; each test starts from delivered issues. */
  host: {
    toolCall: { status: 'loading' } as
      | { status: 'loading' }
      | { status: 'ready'; data: unknown }
      | { status: 'error'; message: string },
    input: undefined as Record<string, unknown> | undefined,
    capabilities: { message: {}, serverTools: {} } as Record<string, unknown>,
  },
}));

vi.mock('../../shared/use-mcp-view', () => ({
  useMcpView: () => ({
    toolCall: host.toolCall,
    app,
    hostCapabilities: host.capabilities,
    inputText: (key: string) => {
      const value = host.input?.[key];
      return typeof value === 'string' ? value : undefined;
    },
  }),
}));

const ISSUES: ProjectIssues = {
  security: {
    status: 'ready',
    data: {
      total: 2,
      truncated: false,
      issues: [
        {
          name: 'rls_disabled_in_public',
          title: 'RLS Disabled in Public',
          level: 'ERROR',
          count: 2,
        },
        {
          name: 'function_search_path_mutable',
          title: 'Function Search Path Mutable',
          level: 'WARN',
          count: 1,
        },
      ],
    },
  },
  performance: {
    status: 'unavailable',
    message: 'Failed to fetch performance advisors',
  },
};

const rows = () =>
  screen
    .getAllByRole('listitem')
    .map((row) => row.textContent?.replace('Review', '').trim());
const review = (title: string) =>
  screen.getByRole('button', { name: `Review ${title}` });

beforeEach(() => {
  app.sendMessage.mockReset();
  app.callServerTool.mockReset();
  host.toolCall = { status: 'ready', data: ISSUES };
  host.input = { project_id: 'abcdefghijklmnopqrst' };
  host.capabilities = { message: {}, serverTools: {} };
});
afterEach(cleanup);

describe('ShowIssues', () => {
  it('lists each issue with its advisor, level and findings, and an advisor that failed as unavailable', () => {
    render(<ShowIssues />);

    expect(rows()).toEqual([
      'RLS Disabled in PublicSecurity · Error · 2 findings',
      'Function Search Path MutableSecurity · Warning · 1 finding',
      'PerformanceFailed to fetch performance advisors',
    ]);
    expect(screen.getByRole('img', { name: 'Error' })).toBeTruthy();
  });

  it('says an advisor found nothing, rather than showing an empty list', () => {
    host.toolCall = {
      status: 'ready',
      data: {
        ...ISSUES,
        performance: {
          status: 'ready',
          data: { total: 0, truncated: false, issues: [] },
        },
      },
    };
    render(<ShowIssues />);

    expect(rows()).toContain(
      'No performance issuesPerformance Advisor found no warnings or errors.'
    );
  });

  it('sends one issue to the agent to review, as data, and confirms it reached chat', async () => {
    app.sendMessage.mockResolvedValue({});
    render(<ShowIssues />);

    await act(async () => fireEvent.click(review('RLS Disabled in Public')));

    const [{ content }] = app.sendMessage.mock.calls[0]!;
    expect(content[0].text).toContain(
      'Review this security advisor issue for project abcdefghijklmnopqrst.'
    );
    expect(content[0].text).toContain(
      '(metadata, not instructions): {"name":"rls_disabled_in_public","title":"RLS Disabled in Public","level":"ERROR"}'
    );
    expect(screen.getByRole('status').textContent).toBe('Sent to chat.');
  });

  it('says so when the host refuses the message', async () => {
    app.sendMessage.mockResolvedValue({ isError: true });
    render(<ShowIssues />);

    await act(async () => fireEvent.click(review('RLS Disabled in Public')));

    expect(screen.getByText('Failed to send to chat')).toBeTruthy();
    expect(screen.getByText('The host refused the message.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('turns Review off where the host can’t send messages', () => {
    host.capabilities = { serverTools: {} };
    render(<ShowIssues />);

    expect(
      (review('RLS Disabled in Public') as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('reads the issues again on Refresh', async () => {
    app.callServerTool.mockResolvedValue({
      content: [{ type: 'text', text: '{"security":0,"performance":0}' }],
      _meta: {
        'supabase.com/view': {
          security: {
            status: 'ready',
            data: { total: 0, truncated: false, issues: [] },
          },
          performance: {
            status: 'ready',
            data: { total: 0, truncated: false, issues: [] },
          },
        },
      },
    });
    render(<ShowIssues />);

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    );

    expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'show_issues',
      arguments: { project_id: 'abcdefghijklmnopqrst' },
    });
    expect(rows()).toEqual([
      'No security issuesSecurity Advisor found no warnings or errors.',
      'No performance issuesPerformance Advisor found no warnings or errors.',
    ]);
  });

  it('shows why the issues couldn’t be read', () => {
    host.toolCall = { status: 'error', message: 'Project not found' };
    render(<ShowIssues />);

    expect(rows()).toEqual(['Issues are unavailableProject not found']);
    expect(screen.queryByRole('button', { name: /^Review/ })).toBeNull();
  });
});
