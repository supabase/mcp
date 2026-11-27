import { describe, expect, it } from 'vitest';
import { presentList } from './list-model';
import {
  CANNOT_RELOAD_MESSAGE,
  REFRESH_TOOL_DESCRIPTION,
  REFRESH_TOOL_NAME,
  type Reload,
  refreshTool,
  reloadSummary,
} from './refresh-tool';
import type { IssuesView, ServerAccess } from './use-issues';

const noop = () => {};

/** An active issues view with this access to the server. */
const active = (server: ServerAccess): IssuesView => ({
  status: 'active',
  type: 'all',
  list: presentList({ status: 'opening' }, 0, 5),
  previous: noop,
  next: noop,
  server,
});

const reloading = (reload: Reload) =>
  active({ kind: 'tools', refresh: noop, reload });

describe('reloadSummary', () => {
  it.each([
    [{ before: 23, after: 21 }, 'Issues reloaded: 21 issues, was 23.'],
    [{ before: 2, after: 1 }, 'Issues reloaded: 1 issue, was 2.'],
    [{ after: 0 }, 'Issues reloaded: 0 issues.'],
    [{ before: 1 }, 'Issues reloaded. There was 1 issue before.'],
    [{ before: 4 }, 'Issues reloaded. There were 4 issues before.'],
    [{}, 'Issues reloaded.'],
  ])('%o: %s', (counts, text) => {
    expect(reloadSummary(counts)).toBe(text);
  });
});

describe('refreshTool', () => {
  it('has a first line that stands alone, under 200 characters', () => {
    const [firstLine] = REFRESH_TOOL_DESCRIPTION.split('\n');
    expect(firstLine).toBe(REFRESH_TOOL_DESCRIPTION);
    expect(firstLine!.length).toBeLessThan(200);
  });

  it('reloads and returns the counts as one line', async () => {
    const tool = refreshTool(
      reloading(async () => ({ before: 23, after: 21 }))
    );
    expect(tool).toMatchObject({
      name: REFRESH_TOOL_NAME,
      description: REFRESH_TOOL_DESCRIPTION,
      disabled: false,
    });
    await expect(tool.handler()).resolves.toBe(
      'Issues reloaded: 21 issues, was 23.'
    );
  });

  it('throws the reload error when the reload fails', async () => {
    const tool = refreshTool(
      reloading(async () => {
        throw new Error('Forbidden');
      })
    );
    await expect(tool.handler()).rejects.toThrow(new Error('Forbidden'));
  });

  it("says the view can't reload on a host without tool calls", async () => {
    const tool = refreshTool(active({ kind: 'delivered' }));
    expect(tool.disabled).toBe(false);
    await expect(tool.handler()).rejects.toThrow(
      new Error(CANNOT_RELOAD_MESSAGE)
    );
  });

  it("is disabled once the view retires, and says it can't reload", async () => {
    const tool = refreshTool({ status: 'retired' });
    expect(tool.disabled).toBe(true);
    await expect(tool.handler()).rejects.toThrow(
      new Error(CANNOT_RELOAD_MESSAGE)
    );
  });
});
