import { describe, expect, it, vi } from 'vitest';
import type { CallTool } from '../../shared/call-tool';
import { fetchIssuesPage } from './issues-client';
import { OUT_OF_STEP_MESSAGE } from './issues-schema';

function fakeCallTool(result: unknown) {
  const callTool = vi.fn().mockResolvedValue(result);
  return { callTool: callTool as unknown as CallTool, mock: callTool };
}

const row = {
  id: 'rls_disabled_in_public',
  category: 'security',
  title: 'RLS disabled in public',
  severity: 'critical',
  affected_count: 3,
};

describe('fetchIssuesPage', () => {
  it('asks for the first page with only the type', async () => {
    const { callTool, mock } = fakeCallTool({ issues: [] });
    await fetchIssuesPage(callTool, { type: 'all', cursor: null });
    expect(mock).toHaveBeenCalledWith('app_paginate_issues', { type: 'all' });
  });

  it('passes the project and cursor when known', async () => {
    const { callTool, mock } = fakeCallTool({ issues: [] });
    await fetchIssuesPage(callTool, {
      type: 'security',
      cursor: 'next',
      projectId: 'abcdefghijklmnopqrst',
    });
    expect(mock).toHaveBeenCalledWith('app_paginate_issues', {
      project_id: 'abcdefghijklmnopqrst',
      type: 'security',
      cursor: 'next',
    });
  });

  it('returns the parsed page and its dropped rows', async () => {
    const { callTool } = fakeCallTool({
      issues: [row, { id: 'bad' }],
      next_cursor: 'next',
    });
    await expect(
      fetchIssuesPage(callTool, { type: 'all', cursor: null })
    ).resolves.toEqual({
      page: { issues: [row], checks: [], next_cursor: 'next' },
      dropped: 1,
    });
  });

  it('throws when the result is not a page', async () => {
    const { callTool } = fakeCallTool({ rows: [] });
    await expect(
      fetchIssuesPage(callTool, { type: 'all', cursor: null })
    ).rejects.toThrow(OUT_OF_STEP_MESSAGE);
  });

  it('passes on tool errors', async () => {
    const callTool = vi
      .fn()
      .mockRejectedValue(new Error('Project not found')) as unknown as CallTool;
    await expect(
      fetchIssuesPage(callTool, { type: 'all', cursor: null })
    ).rejects.toThrow('Project not found');
  });
});
