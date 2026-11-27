/**
 * What the components draw for the list: one model from the listing and the
 * visible page, so no component reads the machine's states. Pure.
 */
import type { IssueCheck, IssueSummary } from './issues-schema';
import { type Listing, pageWindow, type Ready, tailEnded } from './issues-list';

/** "1–5 of 23", or "1–5" when the total isn't known. */
export function rangeLabel(start: number, count: number, total?: number) {
  const range =
    count > 1 ? `${start + 1}–${start + count}` : String(start + count);
  return total === undefined ? range : `${range} of ${total}`;
}

/** What the list shows: the page's rows, or what stands in for them. */
export type ListContent =
  /** The tool call that opened the view gave no list. */
  | { status: 'unavailable'; reason: string }
  /** A page of placeholder rows, `rows` of them. */
  | { status: 'loading'; rows: number }
  | { status: 'failed'; message: string }
  /**
   * No issues. With `incompleteChecks`, some checks couldn't be read, so an
   * empty list isn't "no issues".
   */
  | { status: 'empty'; incompleteChecks: boolean }
  | { status: 'ready'; items: IssueSummary[] };

/** More issues exist than were delivered, and this host can't load them. */
export type PartialList = { shown: number; total?: number };

export type ListModel = {
  content: ListContent;
  /** Reloading from the first page. */
  refreshing: boolean;
  /**
   * No rows are known yet: the first page is loading, from the tool result
   * that opened the view or from a refresh, so the whole list is a
   * placeholder. Not while only a later page loads: the pager and the
   * selection are live then.
   */
  loadingAll: boolean;
  /**
   * Refresh can be pressed: not while the first page loads, whether from
   * the tool result that opened the view or from a refresh.
   */
  canRefresh: boolean;
  /** "1–5 of 23" for a page with rows. */
  range?: string;
  /**
   * Once the list has more than one page: the rows per page, whose height
   * the list keeps, and the pager.
   */
  reserve?: number;
  pager?: { hasPrevious: boolean; hasNext: boolean };
  /** The page shown, 0-based (see `PageWindow`). */
  page: number;
  /** Showing this page needs rows that aren't loaded: send `more`. */
  needsMore: boolean;
  /** What a screen reader hears as the list changes: loading, then the page. */
  announce?: string;
  /** What a screen reader must hear at once: why there is no list or page. */
  alert?: string;
  notices: {
    /** Categories whose checks couldn't be read. */
    unreadChecks: IssueCheck[];
    /** Rows that couldn't be shown. */
    dropped: number;
    partial?: PartialList;
  };
};

const LOADING_ANNOUNCEMENT = 'Loading issues';

const noNotices: ListModel['notices'] = { unreadChecks: [], dropped: 0 };

/** The list as drawn for view page `page` (0-based) of `pageSize` rows. */
export function presentList(
  listing: Listing,
  page: number,
  pageSize: number
): ListModel {
  const unpaged = {
    page: 0,
    needsMore: false,
    notices: noNotices,
    loadingAll: false,
  };
  switch (listing.status) {
    case 'opening':
    case 'loading':
      return {
        ...unpaged,
        content: { status: 'loading', rows: pageSize },
        loadingAll: true,
        refreshing: listing.status === 'loading',
        canRefresh: false,
        announce: LOADING_ANNOUNCEMENT,
      };
    case 'unavailable':
      return {
        ...unpaged,
        content: { status: 'unavailable', reason: listing.reason },
        refreshing: false,
        canRefresh: true,
        alert: `Issues are unavailable. ${listing.reason}`,
      };
    case 'failed':
      return {
        ...unpaged,
        content: { status: 'failed', message: listing.message },
        refreshing: false,
        canRefresh: true,
        alert: listing.message,
      };
    case 'ready':
      return presentReady(listing, page, pageSize);
    default:
      return listing satisfies never;
  }
}

function presentReady(
  listing: Ready,
  page: number,
  pageSize: number
): ListModel {
  const { items, tail, total } = listing;
  const visible = pageWindow(listing, page, pageSize);
  const { rows } = visible;
  const unreadChecks = listing.checks.filter(
    (check) => check.status === 'unavailable'
  );
  const range =
    rows.status === 'ready' && rows.items.length > 0
      ? rangeLabel(visible.start, rows.items.length, total)
      : undefined;
  const multiPage = items.length > pageSize || !tailEnded(tail);

  const base = {
    loadingAll: false,
    refreshing: false,
    canRefresh: true,
    range,
    reserve: multiPage ? pageSize : undefined,
    pager: multiPage
      ? { hasPrevious: visible.hasPrevious, hasNext: visible.hasNext }
      : undefined,
    page: visible.page,
    needsMore: visible.needsMore,
    notices: {
      unreadChecks,
      dropped: listing.dropped,
      partial:
        tail.status === 'unreachable'
          ? { shown: items.length, total }
          : undefined,
    },
  };

  switch (rows.status) {
    case 'loading':
      return {
        ...base,
        content: { status: 'loading', rows: pageSize },
        announce: LOADING_ANNOUNCEMENT,
      };
    case 'failed':
      return {
        ...base,
        content: { status: 'failed', message: rows.message },
        alert: rows.message,
      };
    case 'ready':
      return rows.items.length === 0
        ? {
            ...base,
            content: {
              status: 'empty',
              incompleteChecks: unreadChecks.length > 0,
            },
            announce: 'No issues found',
          }
        : {
            ...base,
            content: { status: 'ready', items: rows.items },
            announce: `Issues ${range}`,
          };
    default:
      return rows satisfies never;
  }
}
