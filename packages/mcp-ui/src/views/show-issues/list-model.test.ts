import { describe, expect, it } from 'vitest';
import type { Ready } from './issues-list';
import type { IssueSummary } from './issues-schema';
import { presentList, rangeLabel } from './list-model';

const issue = (n: number): IssueSummary => ({
  id: `check_${n}`,
  category: 'security',
  title: `Check ${n}`,
  severity: 'warning',
  affected_count: 1,
});
const issues = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => issue(from + i));

const ready = (
  items: IssueSummary[],
  tail: Ready['tail'] = { status: 'end' },
  over: Partial<Ready> = {}
): Ready => ({ status: 'ready', items, checks: [], dropped: 0, tail, ...over });

const noNotices = { unreadChecks: [], dropped: 0 };

describe('presentList', () => {
  describe('before there are rows', () => {
    it('shows loading rows while waiting for the tool result, with Refresh disabled but no spinner', () => {
      expect(presentList({ status: 'opening' }, 2, 5)).toEqual({
        content: { status: 'loading', rows: 5 },
        refreshing: false,
        canRefresh: false,
        loadingAll: true,
        page: 0,
        needsMore: false,
        announce: 'Loading issues',
        notices: noNotices,
      });
    });

    it('shows loading rows and the Refresh spinner while the first page reloads', () => {
      const model = presentList({ status: 'loading' }, 0, 4);
      expect(model.content).toEqual({ status: 'loading', rows: 4 });
      expect(model.refreshing).toBe(true);
      expect(model.canRefresh).toBe(false);
      expect(model.loadingAll).toBe(true);
      expect(model.announce).toBe('Loading issues');
    });

    it('says why the tool call gave no list, at once', () => {
      expect(
        presentList(
          { status: 'unavailable', reason: 'Project not found' },
          0,
          5
        )
      ).toEqual({
        content: { status: 'unavailable', reason: 'Project not found' },
        refreshing: false,
        canRefresh: true,
        loadingAll: false,
        page: 0,
        needsMore: false,
        alert: 'Issues are unavailable. Project not found',
        notices: noNotices,
      });
    });

    it('shows a failed first page, with no paging', () => {
      expect(presentList({ status: 'failed', message: 'gone' }, 2, 5)).toEqual({
        content: { status: 'failed', message: 'gone' },
        refreshing: false,
        canRefresh: true,
        loadingAll: false,
        page: 0,
        needsMore: false,
        alert: 'gone',
        notices: noNotices,
      });
    });
  });

  describe('a ready list', () => {
    it('shows one page without a pager', () => {
      const model = presentList(
        ready(issues(0, 2), { status: 'end' }, { total: 2 }),
        0,
        5
      );
      expect(model).toEqual({
        content: { status: 'ready', items: issues(0, 2) },
        refreshing: false,
        canRefresh: true,
        loadingAll: false,
        range: '1–2 of 2',
        reserve: undefined,
        pager: undefined,
        page: 0,
        needsMore: false,
        announce: 'Issues 1–2 of 2',
        notices: { ...noNotices, partial: undefined },
      });
    });

    it('pages a longer list and keeps a full page of height', () => {
      const model = presentList(ready(issues(0, 12)), 2, 5);
      expect(model.content).toEqual({ status: 'ready', items: issues(10, 12) });
      expect(model.range).toBe('11–12');
      expect(model.reserve).toBe(5);
      expect(model.pager).toEqual({ hasPrevious: true, hasNext: false });
      expect(model.page).toBe(2);
    });

    it('pages a single loaded page when the server has more', () => {
      const model = presentList(
        ready(issues(0, 3), { status: 'more', cursor: 'c1' }),
        0,
        5
      );
      expect(model.pager).toBeDefined();
      expect(model.reserve).toBe(5);
    });

    it('asks for more for a page beyond the loaded rows, and shows it loading', () => {
      const model = presentList(
        ready(issues(0, 20), { status: 'more', cursor: 'c1' }),
        4,
        5
      );
      expect(model.needsMore).toBe(true);
      expect(model.content).toEqual({ status: 'loading', rows: 5 });
      // Only that page is loading, not the list.
      expect(model.loadingAll).toBe(false);
      expect(model.announce).toBe('Loading issues');
      expect(model.range).toBeUndefined();
    });

    it('shows no Refresh spinner while more loads', () => {
      const model = presentList(
        ready(issues(0, 20), { status: 'loading', cursor: 'c1' }),
        4,
        5
      );
      expect(model.refreshing).toBe(false);
      expect(model.canRefresh).toBe(true);
      expect(model.loadingAll).toBe(false);
      expect(model.needsMore).toBe(false);
    });

    it('shows a failed next page on that page, at once', () => {
      const model = presentList(
        ready(issues(0, 20), { status: 'failed', message: 'down' }),
        4,
        5
      );
      expect(model.content).toEqual({ status: 'failed', message: 'down' });
      expect(model.alert).toBe('down');
      expect(model.announce).toBeUndefined();
      expect(model.pager).toEqual({ hasPrevious: true, hasNext: false });
    });

    it('says no issues for an empty list', () => {
      const model = presentList(ready([]), 0, 5);
      expect(model.content).toEqual({
        status: 'empty',
        incompleteChecks: false,
      });
      expect(model.announce).toBe('No issues found');
      expect(model.range).toBeUndefined();
    });

    it("never says no issues when a category couldn't be read", () => {
      const check = {
        type: 'health',
        status: 'unavailable',
        reason: 'Service Unavailable',
      } as const;
      const model = presentList(
        ready(
          [],
          { status: 'end' },
          {
            checks: [{ type: 'security', status: 'complete' }, check],
          }
        ),
        0,
        5
      );
      expect(model.content).toEqual({
        status: 'empty',
        incompleteChecks: true,
      });
      expect(model.notices.unreadChecks).toEqual([check]);
    });

    it('does not warn about a category the platform does not offer', () => {
      const model = presentList(
        ready(
          [],
          { status: 'end' },
          {
            checks: [
              { type: 'security', status: 'complete' },
              {
                type: 'health',
                status: 'unsupported',
                reason: 'Health issues are not supported by this platform',
              },
            ],
          }
        ),
        0,
        5
      );
      expect(model.content).toEqual({
        status: 'empty',
        incompleteChecks: false,
      });
      expect(model.notices.unreadChecks).toEqual([]);
    });

    it('warns only about the unavailable check beside an unsupported one', () => {
      const unavailable = {
        type: 'performance',
        status: 'unavailable',
        reason: 'Service Unavailable',
      } as const;
      const model = presentList(
        ready(
          [],
          { status: 'end' },
          {
            checks: [unavailable, { type: 'health', status: 'unsupported' }],
          }
        ),
        0,
        5
      );
      expect(model.content).toEqual({
        status: 'empty',
        incompleteChecks: true,
      });
      expect(model.notices.unreadChecks).toEqual([unavailable]);
    });

    it('reports rows that could not be read', () => {
      const model = presentList(
        ready(issues(0, 1), { status: 'end' }, { dropped: 2 }),
        0,
        5
      );
      expect(model.notices.dropped).toBe(2);
    });
  });

  describe('more the host cannot fetch', () => {
    it('pages the delivered rows and says the list is partial', () => {
      const model = presentList(
        ready(issues(0, 20), { status: 'unreachable' }, { total: 23 }),
        3,
        5
      );
      expect(model.range).toBe('16–20 of 23');
      expect(model.pager).toEqual({ hasPrevious: true, hasNext: false });
      expect(model.needsMore).toBe(false);
      expect(model.notices.partial).toEqual({ shown: 20, total: 23 });
    });

    it('has no pager when the delivered rows fit one page', () => {
      const model = presentList(
        ready(issues(0, 3), { status: 'unreachable' }),
        0,
        5
      );
      expect(model.pager).toBeUndefined();
      expect(model.reserve).toBeUndefined();
      expect(model.notices.partial).toEqual({ shown: 3, total: undefined });
    });
  });
});

describe('rangeLabel', () => {
  it.each([
    [0, 5, 23, '1–5 of 23'],
    [5, 5, undefined, '6–10'],
    [20, 1, 21, '21 of 21'],
  ] as const)('from %i, %i rows of %s', (start, count, total, expected) => {
    expect(rangeLabel(start, count, total)).toBe(expected);
  });
});
