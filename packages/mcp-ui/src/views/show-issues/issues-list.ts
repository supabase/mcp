/**
 * What the issues view has loaded, is loading, or failed to load. Pure: the
 * wiring runs the `fetchPage` effects and sends back `pageLoaded` or
 * `pageFailed` with the request's id. Which view page is on screen is view
 * state, outside this machine; `pageWindow` maps one onto the loaded items.
 */
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import type { InvalidCursorCode } from '@supabase/mcp-server-supabase/show-issues';
import type { Transition } from '../../shared/use-machine';
import {
  type IssueCheck,
  type IssueCounts,
  type IssueSummary,
  issueKey,
  type ParsedIssuesPage,
} from './issues-schema';

/**
 * One request to the server for a page of issues. `id` tells answers apart:
 * keyset cursors repeat after a refresh, so the cursor alone can't.
 */
export type PageRequest = {
  id: number;
  cursor: string | null;
};

/** Whether more issues can be loaded after the ones in a ready listing. */
export type Tail =
  /** No more on the server. */
  | { status: 'end' }
  /** More exist, none requested. */
  | { status: 'more'; cursor: string }
  | { status: 'loading'; cursor: string }
  /** Loading more failed. Refresh starts over from the first page. */
  | { status: 'failed'; message: string }
  /** More exist, but this host can't fetch them: the list stays partial. */
  | { status: 'unreachable' };

export type Listing =
  /** Waiting for the result of the tool call that opened the view. */
  | { status: 'opening' }
  /**
   * That tool call gave no list: it failed, was cancelled, or its result
   * couldn't be read. Refresh replaces it.
   */
  | { status: 'unavailable'; reason: string }
  /** The first page is on its way from the server. */
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready';
      /** Everything loaded so far, in order, without repeats. */
      items: IssueSummary[];
      total?: number;
      counts?: IssueCounts;
      checks: IssueCheck[];
      /** When the first page was read: the oldest data on screen. */
      readAt?: string;
      /** Rows the parser could not read, across all pages. */
      dropped: number;
      tail: Tail;
    };

export type State = {
  listing: Listing;
  /** The id of the newest request: only its answer is accepted. */
  lastRequest: number;
};

export type Event =
  /**
   * The result of the tool call that opened the view arrived. `canFetch`
   * when the host lets the view load more.
   */
  | {
      type: 'delivered';
      page: ParsedIssuesPage;
      dropped: number;
      canFetch: boolean;
    }
  /** The tool call that opened the view gave no list, and why. */
  | { type: 'openFailed'; reason: string }
  /** Load the next server page. */
  | { type: 'more' }
  | { type: 'refresh' }
  /** The answer to the request with this `id`. */
  | { type: 'pageLoaded'; id: number; page: ParsedIssuesPage; dropped: number }
  | {
      type: 'pageFailed';
      id: number;
      message: string;
      /** The server's error code, if it sent one (see `INVALID_CURSOR_CODE`). */
      code?: string;
    };

export type Effect = { type: 'fetchPage'; request: PageRequest };

/** Shown when the server rejects the cursor; Refresh starts over. */
export const LIST_CHANGED_MESSAGE =
  'The list changed. Refresh to load it again from the start.';

/**
 * The error code `app_paginate_issues` sends when it rejects a cursor
 * (`INVALID_CURSOR_CODE` in mcp-server-supabase `src/apps/show-issues.ts`).
 * Typed by the server's literal, so a change there fails typecheck here.
 */
export const INVALID_CURSOR_CODE: InvalidCursorCode = 'invalid_cursor';

export const initialIssuesList: State = {
  listing: { status: 'opening' },
  lastRequest: 0,
};

/** Moves to `listing` and fetches the page after `cursor`, as the newest request. */
function fetching(
  state: State,
  listing: Listing,
  cursor: string | null
): { state: State; effects: Effect[] } {
  const request: PageRequest = { id: state.lastRequest + 1, cursor };
  return {
    state: { ...state, listing, lastRequest: request.id },
    effects: [{ type: 'fetchPage', request }],
  };
}

const tailOf = (page: ParsedIssuesPage, canFetch: boolean): Tail => {
  if (!page.next_cursor) return { status: 'end' };
  return canFetch
    ? { status: 'more', cursor: page.next_cursor }
    : { status: 'unreachable' };
};

/** Appends `incoming` to `items`, skipping issues already there. */
function appendNew(items: IssueSummary[], incoming: IssueSummary[]) {
  const seen = new Set(items.map(issueKey));
  const added = incoming.filter((issue) => {
    const key = issueKey(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...items, ...added];
}

function firstPage(
  page: ParsedIssuesPage,
  dropped: number,
  canFetch: boolean
): Listing {
  return {
    status: 'ready',
    items: appendNew([], page.issues),
    total: page.total,
    counts: page.counts,
    checks: page.checks,
    readAt: page.read_at,
    dropped,
    tail: tailOf(page, canFetch),
  };
}

export const issuesListTransition: Transition<State, Event, Effect> = (
  state,
  event
) => {
  const { listing } = state;
  switch (event.type) {
    case 'delivered':
      if (listing.status !== 'opening') return null;
      return {
        state: {
          ...state,
          listing: firstPage(event.page, event.dropped, event.canFetch),
        },
      };

    case 'openFailed':
      if (listing.status !== 'opening') return null;
      return {
        state: {
          ...state,
          listing: { status: 'unavailable', reason: event.reason },
        },
      };

    case 'more':
      if (listing.status !== 'ready' || listing.tail.status !== 'more') {
        return null;
      }
      return fetching(
        state,
        {
          ...listing,
          tail: { status: 'loading', cursor: listing.tail.cursor },
        },
        listing.tail.cursor
      );

    case 'refresh':
      // Already loading the first page: don't fetch it twice.
      if (listing.status === 'loading') return null;
      return fetching(state, { status: 'loading' }, null);

    case 'pageLoaded': {
      if (event.id !== state.lastRequest) return null;
      if (listing.status === 'loading') {
        return {
          state: {
            ...state,
            listing: firstPage(event.page, event.dropped, true),
          },
        };
      }
      if (listing.status !== 'ready' || listing.tail.status !== 'loading') {
        return null;
      }
      const { page } = event;
      return {
        state: {
          ...state,
          listing: {
            ...listing,
            items: appendNew(listing.items, page.issues),
            // The newest counts win; the server sends them on every page.
            total: page.total ?? listing.total,
            counts: page.counts ?? listing.counts,
            checks: page.checks,
            dropped: listing.dropped + event.dropped,
            tail: tailOf(page, true),
          },
        },
      };
    }

    case 'pageFailed': {
      if (event.id !== state.lastRequest) return null;
      if (listing.status === 'loading') {
        return {
          state: {
            ...state,
            listing: { status: 'failed', message: event.message },
          },
        };
      }
      if (listing.status !== 'ready' || listing.tail.status !== 'loading') {
        return null;
      }
      // A rejected cursor means the list changed shape (or a server of
      // another version): say so, rather than the server's message.
      const message =
        event.code === INVALID_CURSOR_CODE
          ? LIST_CHANGED_MESSAGE
          : event.message;
      return {
        state: {
          ...state,
          listing: { ...listing, tail: { status: 'failed', message } },
        },
      };
    }
  }
};

export type Ready = Extract<Listing, { status: 'ready' }>;

export type PageWindow = {
  /** What to draw for this view page. */
  rows:
    | { status: 'ready'; items: IssueSummary[] }
    | { status: 'loading' }
    | { status: 'failed'; message: string };
  /**
   * The page shown, 0-based. Smaller than the page asked for when that is
   * past the end of a complete list.
   */
  page: number;
  /** Index of the page's first row, for a "6–10 of 23" label. */
  start: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** Showing this page needs rows that aren't loaded: send `more`. */
  needsMore: boolean;
};

/** No more rows will arrive: the server has none, or this host can't fetch them. */
export const tailEnded = (tail: Tail) =>
  tail.status === 'end' || tail.status === 'unreachable';

/**
 * The view page `page` (0-based) of `pageSize` rows over a ready listing. A
 * page that reaches past the loaded items shows loading (or the tail's
 * failure) until they arrive, unless the list has ended. Never relies on
 * `total`.
 */
export function pageWindow(
  listing: Ready,
  page: number,
  pageSize: number
): PageWindow {
  const { items, tail } = listing;
  const ended = tailEnded(tail);
  const lastPage = Math.max(0, Math.ceil(items.length / pageSize) - 1);
  const shown = ended
    ? Math.min(Math.max(page, 0), lastPage)
    : Math.max(page, 0);
  const start = shown * pageSize;
  const end = start + pageSize;
  const loaded = ended || end <= items.length;

  return {
    rows: loaded
      ? { status: 'ready', items: items.slice(start, end) }
      : tail.status === 'failed'
        ? { status: 'failed', message: tail.message }
        : { status: 'loading' },
    page: shown,
    start,
    hasPrevious: shown > 0,
    // Past a fully loaded page, the next one is loaded or can be.
    hasNext: loaded && (end < items.length || !ended),
    needsMore: !loaded && tail.status === 'more',
  };
}

/** Rows per view page when the host gives no height limit. */
export const PAGE_SIZE = 5;
const MIN_PAGE_SIZE = 3;
/** Every row is one line of title and one of meta, so they're all this tall. */
export const ROW_HEIGHT = 56;
/** Header and footer around the rows. */
export const CHROME_HEIGHT = 90;

/**
 * Rows per view page: 5, unless the host reports a `maxHeight` too small
 * for 5 rows plus the header and footer. Then as many as fit, but at least 3.
 */
export function pageSizeFor(
  containerDimensions: McpUiHostContext['containerDimensions']
): number {
  const maxHeight =
    containerDimensions && 'maxHeight' in containerDimensions
      ? containerDimensions.maxHeight
      : undefined;
  if (maxHeight === undefined) return PAGE_SIZE;
  const fits = Math.floor((maxHeight - CHROME_HEIGHT) / ROW_HEIGHT);
  return Math.min(PAGE_SIZE, Math.max(MIN_PAGE_SIZE, fits));
}
