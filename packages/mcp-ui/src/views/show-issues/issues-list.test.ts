import { describe, expect, it } from 'vitest';
import type { IssueSummary, ParsedIssuesPage } from './issues-schema';
import {
  type Event,
  INVALID_CURSOR_CODE,
  initialIssuesList,
  issuesListTransition,
  LIST_CHANGED_MESSAGE,
  type Listing,
  pageSizeFor,
  pageWindow,
  type Ready,
  type State,
} from './issues-list';

const issue = (n: number, over: Partial<IssueSummary> = {}): IssueSummary => ({
  id: `check_${n}`,
  category: 'security',
  title: `Check ${n}`,
  severity: 'warning',
  affected_count: 1,
  ...over,
});
const issues = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => issue(from + i));

const page = (
  rows: IssueSummary[],
  next_cursor: string | null = null,
  over: Partial<ParsedIssuesPage> = {}
): ParsedIssuesPage => ({ issues: rows, checks: [], next_cursor, ...over });

/** Runs events in order; a disallowed one throws, so tests can't skip one by accident. */
function run(state: State, ...events: Event[]) {
  let effects: unknown[] = [];
  for (const event of events) {
    const next = issuesListTransition(state, event);
    if (!next) throw new Error(`${event.type} not allowed`);
    state = next.state;
    effects = next.effects ?? [];
  }
  return { state, effects };
}

const start = initialIssuesList;
const delivered = (
  p: ParsedIssuesPage,
  dropped = 0,
  canFetch = true
): Event => ({ type: 'delivered', page: p, dropped, canFetch });
const loaded = (id: number, p: ParsedIssuesPage, dropped = 0): Event => ({
  type: 'pageLoaded',
  id,
  page: p,
  dropped,
});
const failed = (id: number, message = 'down', code?: string): Event => ({
  type: 'pageFailed',
  id,
  message,
  ...(code && { code }),
});
const fetches = (id: number, cursor: string | null) => [
  { type: 'fetchPage', request: { id, cursor } },
];
const ready = (listing: Listing) => {
  if (listing.status !== 'ready')
    throw new Error(`listing is ${listing.status}`);
  return listing;
};

/** Delivered 20 issues with more after `c1`. */
const withMore = run(start, delivered(page(issues(0, 20), 'c1'))).state;

describe('issues list machine', () => {
  it('starts waiting for the tool result', () => {
    expect(start).toEqual({
      listing: { status: 'opening' },
      lastRequest: 0,
    });
  });

  it('becomes ready from the delivered page', () => {
    const { state, effects } = run(
      start,
      delivered(
        page(issues(0, 2), null, {
          total: 2,
          read_at: 't1',
          checks: [{ type: 'health', status: 'unavailable' }],
        }),
        1
      )
    );
    expect(state.listing).toEqual({
      status: 'ready',
      items: issues(0, 2),
      total: 2,
      counts: undefined,
      checks: [{ type: 'health', status: 'unavailable' }],
      readAt: 't1',
      dropped: 1,
      tail: { status: 'end' },
    });
    expect(effects).toEqual([]);
  });

  it('accepts the tool result only while waiting for it', () => {
    expect(issuesListTransition(withMore, delivered(page([])))).toBeNull();
  });

  it('marks more it cannot fetch as unreachable, and never asks for it', () => {
    const { state } = run(
      start,
      delivered(page(issues(0, 20), 'c1'), 0, false)
    );
    expect(ready(state.listing).tail).toEqual({ status: 'unreachable' });
    expect(issuesListTransition(state, { type: 'more' })).toBeNull();
  });

  describe('opening', () => {
    it('becomes unavailable when the tool call gave no list', () => {
      const { state } = run(start, {
        type: 'openFailed',
        reason: 'Project not found',
      });
      expect(state.listing).toEqual({
        status: 'unavailable',
        reason: 'Project not found',
      });
      expect(issuesListTransition(state, delivered(page([])))).toBeNull();
    });

    it('accepts the failure only while waiting for the tool result', () => {
      expect(
        issuesListTransition(withMore, { type: 'openFailed', reason: 'x' })
      ).toBeNull();
    });

    it('refreshes from unavailable', () => {
      const unavailable = run(start, { type: 'openFailed', reason: 'x' }).state;
      const { state, effects } = run(
        unavailable,
        { type: 'refresh' },
        loaded(1, page(issues(0, 2)))
      );
      expect(ready(state.listing).items).toEqual(issues(0, 2));
      expect(run(unavailable, { type: 'refresh' }).effects).toEqual(
        fetches(1, null)
      );
      expect(effects).toEqual([]);
    });
  });

  describe('more', () => {
    it('fetches the next page once, however often it is sent', () => {
      const { state, effects } = run(withMore, { type: 'more' });
      expect(effects).toEqual(fetches(1, 'c1'));
      expect(ready(state.listing).tail).toEqual({
        status: 'loading',
        cursor: 'c1',
      });
      expect(issuesListTransition(state, { type: 'more' })).toBeNull();
    });

    it('does nothing at the end or while the first page loads', () => {
      const ended = run(start, delivered(page(issues(0, 3)))).state;
      expect(issuesListTransition(ended, { type: 'more' })).toBeNull();
      expect(issuesListTransition(start, { type: 'more' })).toBeNull();
    });

    it('appends the next page, without repeats, with the newest counts', () => {
      const { state } = run(
        withMore,
        { type: 'more' },
        loaded(
          1,
          page([issue(19), ...issues(20, 25)], null, {
            total: 25,
            counts: { all: 25, security: 25, performance: 0, health: 0 },
            read_at: 't2',
          }),
          2
        )
      );
      const listing = ready(state.listing);
      expect(listing.items).toEqual(issues(0, 25));
      expect(listing.total).toBe(25);
      expect(listing.counts?.all).toBe(25);
      expect(listing.dropped).toBe(2);
      expect(listing.tail).toEqual({ status: 'end' });
    });

    it('does not mistake the same id in another category for a repeat', () => {
      const other = issue(0, { category: 'health' });
      const { state } = run(
        withMore,
        { type: 'more' },
        loaded(1, page([other]))
      );
      expect(ready(state.listing).items).toHaveLength(21);
    });

    it('keeps the first read time and totals a later page leaves out', () => {
      const delivered20 = run(
        start,
        delivered(page(issues(0, 20), 'c1', { total: 30, read_at: 't1' }), 1)
      ).state;
      const { state } = run(
        delivered20,
        { type: 'more' },
        loaded(1, page(issues(20, 30), null, { read_at: 't2' }), 1)
      );
      const listing = ready(state.listing);
      expect(listing.readAt).toBe('t1');
      expect(listing.total).toBe(30);
      expect(listing.dropped).toBe(2);
    });
  });

  describe('stale answers', () => {
    it('drops an answer to a request it is not waiting for', () => {
      const loading = run(withMore, { type: 'more' }).state;
      expect(
        issuesListTransition(loading, loaded(7, page([issue(99)])))
      ).toBeNull();
      expect(issuesListTransition(loading, failed(7))).toBeNull();
      expect(issuesListTransition(loading, loaded(0, page([])))).toBeNull();
    });

    it('drops a next page that arrives after a refresh', () => {
      const refreshing = run(
        withMore,
        { type: 'more' },
        { type: 'refresh' }
      ).state;
      expect(
        issuesListTransition(refreshing, loaded(1, page([issue(99)])))
      ).toBeNull();
      expect(issuesListTransition(refreshing, failed(1))).toBeNull();
    });

    it('drops a next page from before a refresh that reloaded the same cursor', () => {
      // Keyset cursors repeat: the reloaded first page ends at `c1` again.
      const again = run(
        withMore,
        { type: 'more' },
        { type: 'refresh' },
        loaded(2, page(issues(0, 20), 'c1')),
        { type: 'more' }
      );
      expect(again.effects).toEqual(fetches(3, 'c1'));
      expect(
        issuesListTransition(again.state, loaded(1, page([issue(99)])))
      ).toBeNull();
      expect(issuesListTransition(again.state, failed(1))).toBeNull();

      const { state } = run(again.state, loaded(3, page(issues(20, 23))));
      expect(ready(state.listing).items).toEqual(issues(0, 23));
    });

    it('drops answers when nothing was requested', () => {
      expect(issuesListTransition(withMore, loaded(0, page([])))).toBeNull();
      expect(issuesListTransition(start, loaded(0, page([])))).toBeNull();
    });
  });

  describe('failure', () => {
    it('keeps loaded rows when loading more fails, and refresh starts over', () => {
      const { state } = run(withMore, { type: 'more' }, failed(1));
      const listing = ready(state.listing);
      expect(listing.items).toHaveLength(20);
      expect(listing.tail).toEqual({ status: 'failed', message: 'down' });
      expect(issuesListTransition(state, { type: 'more' })).toBeNull();

      const refreshed = run(state, { type: 'refresh' });
      expect(refreshed.state.listing).toEqual({ status: 'loading' });
      expect(refreshed.effects).toEqual(fetches(2, null));
    });

    it('says the list changed when the cursor was rejected', () => {
      const { state } = run(
        withMore,
        { type: 'more' },
        failed(1, 'The cursor is invalid.', INVALID_CURSOR_CODE)
      );
      expect(ready(state.listing).tail).toEqual({
        status: 'failed',
        message: LIST_CHANGED_MESSAGE,
      });
    });

    it("keeps the server's message for any other error code", () => {
      const { state } = run(
        withMore,
        { type: 'more' },
        failed(1, 'The cursor is invalid.', 'other_code')
      );
      expect(ready(state.listing).tail).toEqual({
        status: 'failed',
        message: 'The cursor is invalid.',
      });
    });

    it('fails the listing when the first page fails, and refresh loads it again', () => {
      const { state } = run(withMore, { type: 'refresh' }, failed(1, 'gone'));
      expect(state.listing).toEqual({ status: 'failed', message: 'gone' });
      const refreshed = run(state, { type: 'refresh' });
      expect(refreshed.effects).toEqual(fetches(2, null));
      const { state: done } = run(
        refreshed.state,
        loaded(2, page(issues(0, 1)))
      );
      expect(ready(done.listing).items).toEqual(issues(0, 1));
    });
  });

  describe('refresh', () => {
    it('starts a new listing from the first page', () => {
      const { state, effects } = run(withMore, { type: 'refresh' });
      expect(state.listing).toEqual({ status: 'loading' });
      expect(effects).toEqual(fetches(1, null));
      const { state: done } = run(state, loaded(1, page(issues(5, 7))));
      expect(ready(done.listing).items).toEqual(issues(5, 7));
    });

    it('works before the tool result arrives', () => {
      const { effects } = run(start, { type: 'refresh' });
      expect(effects).toEqual(fetches(1, null));
    });

    it('does not fetch the first page twice', () => {
      const refreshing = run(withMore, { type: 'refresh' }).state;
      expect(issuesListTransition(refreshing, { type: 'refresh' })).toBeNull();
    });
  });
});

describe('pageWindow', () => {
  const listing = (items: IssueSummary[], tail: Ready['tail']): Ready => ({
    status: 'ready',
    items,
    checks: [],
    dropped: 0,
    tail,
  });

  it('shows a full page with more after it', () => {
    expect(pageWindow(listing(issues(0, 20), { status: 'end' }), 1, 5)).toEqual(
      {
        rows: { status: 'ready', items: issues(5, 10) },
        page: 1,
        start: 5,
        hasPrevious: true,
        hasNext: true,
        needsMore: false,
      }
    );
  });

  it('shows a short last page with no Next', () => {
    expect(pageWindow(listing(issues(0, 12), { status: 'end' }), 2, 5)).toEqual(
      {
        rows: { status: 'ready', items: issues(10, 12) },
        page: 2,
        start: 10,
        hasPrevious: true,
        hasNext: false,
        needsMore: false,
      }
    );
  });

  it('offers Next on the last loaded page when the server has more', () => {
    const window = pageWindow(
      listing(issues(0, 20), { status: 'more', cursor: 'c1' }),
      3,
      5
    );
    expect(window.hasNext).toBe(true);
    expect(window.needsMore).toBe(false);
  });

  it('asks for more for a page beyond the loaded items', () => {
    expect(
      pageWindow(listing(issues(0, 20), { status: 'more', cursor: 'c1' }), 4, 5)
    ).toEqual({
      rows: { status: 'loading' },
      page: 4,
      start: 20,
      hasPrevious: true,
      hasNext: false,
      needsMore: true,
    });
  });

  it('shows loading without asking again while more loads', () => {
    const window = pageWindow(
      listing(issues(0, 20), { status: 'loading', cursor: 'c1' }),
      4,
      5
    );
    expect(window.rows).toEqual({ status: 'loading' });
    expect(window.needsMore).toBe(false);
    expect(window.hasPrevious).toBe(true);
  });

  it('shows the failure on the page that needed the rows', () => {
    const window = pageWindow(
      listing(issues(0, 20), { status: 'failed', message: 'down' }),
      4,
      5
    );
    expect(window.rows).toEqual({ status: 'failed', message: 'down' });
    expect(window.hasPrevious).toBe(true);
    expect(window.needsMore).toBe(false);
  });

  it('waits for a page only partly loaded when more exist', () => {
    const window = pageWindow(
      listing(issues(0, 20), { status: 'more', cursor: 'c1' }),
      6,
      3
    );
    expect(window.rows).toEqual({ status: 'loading' });
    expect(window.needsMore).toBe(true);
  });

  it('moves a page past the end of a complete list back to the last page', () => {
    const window = pageWindow(listing(issues(0, 7), { status: 'end' }), 4, 5);
    expect(window.page).toBe(1);
    expect(window.rows).toEqual({ status: 'ready', items: issues(5, 7) });
  });

  it('shows an empty list as one empty page', () => {
    expect(pageWindow(listing([], { status: 'end' }), 0, 5)).toEqual({
      rows: { status: 'ready', items: [] },
      page: 0,
      start: 0,
      hasPrevious: false,
      hasNext: false,
      needsMore: false,
    });
  });

  it('works without a total', () => {
    const window = pageWindow(
      listing(issues(0, 10), { status: 'more', cursor: 'c1' }),
      0,
      5
    );
    expect(window.rows).toEqual({ status: 'ready', items: issues(0, 5) });
    expect(window.hasNext).toBe(true);
  });

  it('treats more it cannot fetch as the end', () => {
    const window = pageWindow(
      listing(issues(0, 20), { status: 'unreachable' }),
      5,
      5
    );
    expect(window.page).toBe(3);
    expect(window.rows).toEqual({ status: 'ready', items: issues(15, 20) });
    expect(window.hasNext).toBe(false);
    expect(window.needsMore).toBe(false);
  });
});

describe('pageSizeFor', () => {
  it.each([
    ['no dimensions', undefined, 5],
    ['no max height', { maxWidth: 400 }, 5],
    ['a fixed height', { height: 200, width: 400 }, 5],
    ['room for 5 rows', { maxHeight: 370 }, 5],
    ['room for more', { maxHeight: 2000 }, 5],
    ['room for 4 rows', { maxHeight: 369 }, 4],
    ['room for 3 rows', { maxHeight: 260 }, 3],
    ['room for fewer', { maxHeight: 100 }, 3],
  ] as const)('%s', (_, dimensions, expected) => {
    expect(pageSizeFor(dimensions)).toBe(expected);
  });
});
