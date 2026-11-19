import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncerProvider } from '../../shared/Announcer';
import { POLL_INTERVAL_MS } from '../../shared/use-creation-status';
import { CreateBranch } from './CreateBranch';

const { app, created, callTool } = vi.hoisted(() => ({
  app: { openLink: () => Promise.resolve({}) },
  created: {
    id: 'branch-id',
    name: 'feature-login',
    project_ref: 'branchrefbranchrefbr',
    parent_project_ref: 'abcdefghijklmnopqrst',
    is_default: false,
    persistent: false,
    status: 'CREATING_PROJECT',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  callTool: vi.fn(),
}));

vi.mock('../../shared/call-tool', () => ({ callTool }));
vi.mock('../../shared/use-mcp-view', () => ({
  useMcpView: () => ({
    toolCall: { status: 'ready', data: created },
    app,
    input: { project_id: created.parent_project_ref, name: created.name },
    hostContext: undefined,
    hostCapabilities: { serverTools: {}, openLinks: {} },
    dashboardUrl: 'https://supabase.com/dashboard',
  }),
}));

/** `list_branches` returns the branch with these statuses in turn; the last repeats. */
function branchReads(...statuses: string[]) {
  let call = 0;
  callTool.mockImplementation(async (_app: unknown, name: string) => {
    if (name === 'get_project') {
      return { name: 'Design check', organization_slug: 'hobby' };
    }
    if (name === 'get_organization') return { name: 'Hobby' };
    const status = statuses[Math.min(call++, statuses.length - 1)]!;
    return { branches: [{ ...created, status }] };
  });
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function renderView() {
  const { container } = render(
    <AnnouncerProvider>
      <CreateBranch />
    </AnnouncerProvider>
  );
  const text = (slot: string) =>
    container.querySelector(`[data-slot="${slot}"]`)?.textContent;
  return {
    badge: () =>
      container.querySelector('.badge [data-slot="label"]')?.textContent,
    note: () => text('note'),
    name: () => text('name'),
    details: () => text('details'),
    breadcrumbs: () => text('breadcrumbs'),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  callTool.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CreateBranch', () => {
  it('shows the branch under its organization and project', async () => {
    branchReads('CREATING_PROJECT');
    const view = renderView();
    await advance(0);

    expect(view.breadcrumbs()).toBe('Hobby/Design check');
    expect(view.name()).toBe('feature-login');
    expect(view.details()).toContain('branchrefbranchrefbr');
  });

  it('names the step while the branch sets up, then shows Active', async () => {
    branchReads(
      'CREATING_PROJECT',
      'RUNNING_MIGRATIONS',
      'MIGRATIONS_PASSED',
      'FUNCTIONS_DEPLOYED'
    );
    const view = renderView();

    await advance(0);
    expect(view.badge()).toBe('Creating');
    await advance(POLL_INTERVAL_MS);
    expect(view.badge()).toBe('Running migrations');
    await advance(POLL_INTERVAL_MS);
    expect(view.badge()).toBe('Deploying functions');
    await advance(POLL_INTERVAL_MS);
    expect(view.badge()).toBe('Active');
    expect(screen.getByText('Connection details')).not.toBeNull();
  });

  it('shows which step failed', async () => {
    branchReads('RUNNING_MIGRATIONS', 'MIGRATIONS_FAILED');
    const view = renderView();

    await advance(0);
    await advance(POLL_INTERVAL_MS);
    expect(view.badge()).toBe('Failed');
    expect(view.note()).toBe(
      'Failed while running migrations (MIGRATIONS_FAILED).'
    );
  });
});
