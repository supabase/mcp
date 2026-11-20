import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncerProvider } from '../../shared/Announcer';
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
} from '../../shared/use-creation-status';
import { CreateProject } from './CreateProject';

const { app, created, callTool, host } = vi.hoisted(() => {
  const created = {
    id: 'abcdefghijklmnopqrst',
    ref: 'abcdefghijklmnopqrst',
    organization_id: 'hobby',
    organization_slug: 'hobby',
    name: 'Design check',
    status: 'COMING_UP',
    created_at: new Date().toISOString(),
    region: 'us-east-1',
  };
  return {
    app: { openLink: vi.fn(() => Promise.resolve({})) },
    created,
    callTool: vi.fn(),
    /** What the host has handed the view; each test starts from a delivered result. */
    host: {
      toolCall: { status: 'ready', data: created } as
        | { status: 'ready'; data: typeof created }
        | { status: 'loading' }
        | { status: 'error'; message: string },
      input: undefined as Record<string, unknown> | undefined,
    },
  };
});

vi.mock('../../shared/call-tool', () => ({ callTool }));
vi.mock('../../shared/use-mcp-view', () => ({
  useMcpView: () => ({
    toolCall: host.toolCall,
    app,
    input: host.input,
    hostContext: undefined,
    hostCapabilities: { serverTools: {}, openLinks: {} },
    dashboardUrl: 'https://supabase.green/dashboard',
  }),
}));

/** `get_project` returns these statuses in turn (an Error rejects); the last repeats. */
function projectReads(...reads: (string | Error)[]) {
  let call = 0;
  callTool.mockImplementation(async (_app: unknown, name: string) => {
    if (name === 'get_organization') {
      if (organizationFails) throw new Error('Organization not found');
      return { name: 'Hobby' };
    }
    const read = reads[Math.min(call++, reads.length - 1)]!;
    if (read instanceof Error) throw read;
    return { ...created, status: read };
  });
}

/** Makes `get_organization` reject, for the breadcrumb lookup. */
let organizationFails = false;

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function renderView() {
  const { container } = render(
    <AnnouncerProvider>
      <CreateProject />
    </AnnouncerProvider>
  );
  return {
    badge: () =>
      container.querySelector('.badge [data-slot="label"]')?.textContent,
    tone: () => container.querySelector('.badge')?.getAttribute('data-tone'),
    note: () => container.querySelector('[data-slot="note"]')?.textContent,
    details: () =>
      container.querySelector('[data-slot="details"]')?.textContent,
    name: () => container.querySelector('[data-slot="name"]')?.textContent,
    breadcrumbs: () =>
      container.querySelector('[data-slot="breadcrumbs"]')?.textContent,
    skeletons: (shape?: string) =>
      container.querySelectorAll(
        shape
          ? `[data-slot="skeleton"][data-shape="${shape}"]`
          : '[data-slot="skeleton"]'
      ).length,
    busy: () =>
      container.querySelector('.project-card')?.getAttribute('aria-busy'),
    /** Retry sits in the title row, beside the badge. */
    retryBesideBadge: () =>
      !!container.querySelector('[data-slot="title-row"] [data-slot="retry"]'),
    dashboardLink: () =>
      screen.queryByRole('button', { name: 'Open in dashboard' }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  callTool.mockReset();
  host.toolCall = { status: 'ready', data: created };
  host.input = undefined;
  organizationFails = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CreateProject', () => {
  it('keeps the card layout with skeletons before the host sends anything', async () => {
    host.toolCall = { status: 'loading' };
    projectReads('COMING_UP');
    const view = renderView();
    await advance(0);

    expect(view.busy()).toBe('true');
    expect(view.name()).toBe('');
    expect(view.badge()).toBeUndefined();
    expect(view.note()).toBeUndefined();
    // Organization, name, ref and region; the badge; Open in dashboard.
    expect(view.skeletons('text')).toBe(4);
    expect(view.skeletons('pill')).toBe(1);
    expect(view.skeletons('square')).toBe(1);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("leaves the organization out when it can't be read", async () => {
    organizationFails = true;
    projectReads('COMING_UP');
    const view = renderView();
    await advance(0);

    expect(view.breadcrumbs()).toBeUndefined();
    expect(view.badge()).toBe('Creating');
  });

  it('fills in what the arguments tell it while waiting for the result', async () => {
    host.toolCall = { status: 'loading' };
    host.input = {
      name: 'Design check',
      region: 'us-east-1',
      organization_id: 'hobby',
    };
    projectReads('COMING_UP');
    const view = renderView();
    await advance(0);

    expect(view.name()).toBe('Design check');
    expect(view.breadcrumbs()).toBe('Hobby');
    expect(view.details()).toContain('us-east-1');
    // Only the ref, the badge and Open in dashboard are still unknown.
    expect(view.skeletons('text')).toBe(1);
    expect(view.skeletons('pill')).toBe(1);
    expect(view.skeletons('square')).toBe(1);
  });

  it('names the step while the project sets up, then shows Active', async () => {
    projectReads('COMING_UP', 'ACTIVE_UNHEALTHY', 'ACTIVE_HEALTHY');
    const view = renderView();

    // In-progress steps are neutral; the spinner says they're moving.
    await advance(0);
    expect(view.badge()).toBe('Creating');
    expect(view.tone()).toBeNull();

    await advance(POLL_INTERVAL_MS);
    expect(view.badge()).toBe('Checking health');
    expect(view.tone()).toBeNull();

    await advance(POLL_INTERVAL_MS);
    expect(view.badge()).toBe('Active');
    expect(view.tone()).toBe('success');
    // Checking is live or finished throughout: nothing to retry.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows which step failed', async () => {
    projectReads('INIT_FAILED');
    const view = renderView();

    await advance(0);
    expect(view.badge()).toBe('Failed');
    expect(view.note()).toBe('Failed while creating (INIT_FAILED).');
    // A failed project is final: retrying would read the same failure.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    // It still exists in the dashboard, which is where it's deleted.
    expect(view.dashboardLink()).not.toBeNull();
  });

  it('has no dashboard link for a project that was removed', async () => {
    projectReads('REMOVED');
    const view = renderView();

    await advance(0);
    expect(view.badge()).toBe('Failed');
    expect(view.dashboardLink()).toBeNull();
  });

  it('opens the dashboard the server links to', async () => {
    projectReads('ACTIVE_HEALTHY');
    const view = renderView();

    await advance(0);
    fireEvent.click(view.dashboardLink()!);
    expect(app.openLink).toHaveBeenCalledWith({
      url: 'https://supabase.green/dashboard/project/abcdefghijklmnopqrst',
    });
  });

  it('has no dashboard link when the project was never created', async () => {
    host.toolCall = {
      status: 'error',
      message: 'Project limit reached for this organization',
    };
    host.input = { name: 'Design check', region: 'us-east-1' };
    const view = renderView();

    await advance(0);
    expect(view.name()).toBe('Design check');
    expect(view.badge()).toBe('Failed');
    expect(view.note()).toBe('Project limit reached for this organization');
    expect(view.dashboardLink()).toBeNull();
    expect(callTool).not.toHaveBeenCalledWith(
      expect.anything(),
      'get_project',
      expect.anything()
    );
  });

  it('offers Retry when the checks keep failing, and resumes', async () => {
    const down = new Error('Service temporarily unavailable');
    projectReads(down, down, down, 'COMING_UP', 'COMING_UP', 'ACTIVE_HEALTHY');
    const view = renderView();

    await advance(0);
    await advance(POLL_INTERVAL_MS);
    await advance(POLL_INTERVAL_MS);
    expect(view.badge()).toBe('Check failed');
    expect(view.note()).toBe(
      "Can't check status: Service temporarily unavailable."
    );
    expect(view.retryBesideBadge()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await advance(0);
    expect(view.badge()).toBe('Creating');
    expect(view.note()).toBeUndefined();

    // Polling resumed: it reaches Active without another Retry.
    await advance(POLL_INTERVAL_MS);
    expect(view.badge()).toBe('Active');
  });

  it('offers Retry after checking for 10 minutes, and resumes', async () => {
    projectReads('COMING_UP');
    const view = renderView();

    await advance(POLL_TIMEOUT_MS);
    expect(view.badge()).toBe('Creating');
    expect(view.note()).toBe('Stopped checking after 10 minutes.');
    expect(view.retryBesideBadge()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await advance(0);
    expect(view.note()).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
