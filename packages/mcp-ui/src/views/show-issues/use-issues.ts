/**
 * The issues view's wiring: runs the view's state machine (the list, the
 * selection and the handoff, until a newer view retires this one), performs
 * its effects (server calls, messages and model context), holds the visible
 * page, and presents the list for the components (`presentList`). The only
 * place in the view that catches errors: each failure becomes an event, and
 * the machine keeps the message in state for the components to draw.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ToolCallError } from '../../shared/call-tool';
import { MessageTooLongError } from '../../shared/send-message';
import { useMachine } from '../../shared/use-machine';
import type { McpView } from '../../shared/use-mcp-view';
import { useSupersession } from '../../shared/use-supersession';
import type { ReviewAction } from './handoff';
import { fetchIssuesPage } from './issues-client';
import {
  type Event,
  type Listing,
  type PageRequest,
  pageSizeFor,
} from './issues-list';
import {
  type IssueSummary,
  type IssueType,
  type ParsedPromptContext,
  parseViewData,
} from './issues-schema';
import { type ListModel, presentList } from './list-model';
import { reviewIssuesPrompt } from './prompts';
import type { Reload } from './refresh-tool';
import { type Selection, selectionContext } from './selection';
import {
  initialViewState,
  type ViewEffect,
  type ViewEvent,
  type ViewState,
  viewTransition,
} from './view-state';

const ISSUE_TYPES: readonly IssueType[] = [
  'all',
  'security',
  'performance',
  'health',
];

/** The `type` `show_issues` was called with; the server's default is `all`. */
export function issueTypeOf(input: Record<string, unknown> | undefined) {
  const type = input?.type;
  return ISSUE_TYPES.find((known) => known === type) ?? 'all';
}

/** This view's name on the channel that retires older views. */
const VIEW_NAME = 'show-issues';

export const TOO_LONG_MESSAGE =
  'Too many issues selected for one message. Select fewer.';
/**
 * Why a hand-off failed, whatever the cause: the host refused the message,
 * the connection failed, or the host can't take messages at all.
 */
export const SEND_FAILED_MESSAGE = 'Could not send message to chat.';
const CANCELLED_MESSAGE = 'The request was cancelled.';
const NO_TOOL_CALLS_MESSAGE = "This host can't load more issues.";

const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** How a page fetch ended, as the event the list machine gets. */
type PageOutcome = Extract<Event, { type: 'pageLoaded' | 'pageFailed' }>;

/** The issues in a ready listing, if known: the total, or all are loaded. */
function listingCount(listing: Listing) {
  if (listing.status !== 'ready') return undefined;
  return (
    listing.total ??
    (listing.tail.status === 'end' ? listing.items.length : undefined)
  );
}

/** What the host lets the view load from the server. */
export type ServerAccess =
  /** The host can call tools. */
  | {
      kind: 'tools';
      /** Reloads from the first page: the way out of any failed load. */
      refresh: () => void;
      /**
       * Refreshes as the button does, and settles once the first page is
       * in, with the counts before and after (for `refresh_issues_view`).
       */
      reload: Reload;
    }
  /**
   * It can't: the delivered issues are all the view will have (see the
   * list's `notices.partial`).
   */
  | { kind: 'delivered' };

/** Selecting issues for the assistant, on a host that can take a selection. */
export type Selecting = {
  selection: Selection;
  toggle: (issue: IssueSummary) => void;
  clear: () => void;
  /** How the selected issues reach the assistant on this host. */
  review: ReviewAction;
};

export type ActiveIssuesView = {
  status: 'active';
  type: IssueType;
  /** The list as drawn. */
  list: ListModel;
  /** Move the visible page. */
  previous: () => void;
  next: () => void;
  /**
   * Absent on a host that can neither take a message from the view nor show
   * the assistant the selection: selecting would do nothing there, so the
   * rows have no checkboxes.
   */
  selecting?: Selecting;
  server: ServerAccess;
};

/**
 * A newer issues view of the same project has opened. This one does nothing
 * more and has nothing to show but a notice.
 */
export type RetiredIssuesView = { status: 'retired' };

export type IssuesView = ActiveIssuesView | RetiredIssuesView;

/**
 * State and actions for the issues view, from the `useMcpView` connection and
 * the `type` `show_issues` was called with (see `issueTypeOf`). Like the
 * project id, the type is read from the tool input, and every page fetch asks
 * for the one the hook has when it runs.
 */
export function useIssues(view: McpView<unknown>, type: IssueType): IssuesView {
  const {
    toolCall,
    inputText,
    hostContext,
    callTool,
    sendMessage,
    updateModelContext,
  } = view;
  // Only from the tool input: a project-scoped server has no `project_id`.
  const projectId = inputText('project_id');

  // Keyed on the data, not `toolCall`, which can be a new object each render.
  // A result without view data (`undefined`) is parsed too, so the user gets
  // `OUT_OF_STEP_MESSAGE`, not a view that loads forever.
  const ready = toolCall.status === 'ready';
  const raw = toolCall.status === 'ready' ? toolCall.data : undefined;
  const delivered = useMemo(() => {
    if (!ready) return undefined;
    try {
      return { result: parseViewData(raw) };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }, [ready, raw]);

  /** Why the tool call that opened the view gave no list, if it gave none. */
  const openFailure =
    toolCall.status === 'error'
      ? toolCall.message
      : toolCall.status === 'cancelled'
        ? (toolCall.reason ?? CANCELLED_MESSAGE)
        : delivered?.error;

  const context: ParsedPromptContext | undefined =
    delivered?.result?.data.context ??
    (projectId ? { project: { id: projectId } } : undefined);

  /** Reads one page from the server, as the event for the list machine. */
  async function readPage(request: PageRequest): Promise<PageOutcome> {
    const { id } = request;
    if (!callTool) {
      return { type: 'pageFailed', id, message: NO_TOOL_CALLS_MESSAGE };
    }
    try {
      const { page, dropped } = await fetchIssuesPage(callTool, {
        type,
        cursor: request.cursor,
        projectId,
      });
      return { type: 'pageLoaded', id, page, dropped };
    } catch (err) {
      return {
        type: 'pageFailed',
        id,
        message: errorMessage(err),
        code: err instanceof ToolCallError ? err.code : undefined,
      };
    }
  }

  // The first-page fetch in flight, if any, for a reload to wait on.
  const firstPage = useRef<Promise<PageOutcome>>(undefined);

  /** Builds the prompt for `issues` and sends it as the user. */
  async function handOff(
    issues: IssueSummary[],
    send: (event: ViewEvent) => void
  ) {
    if (!sendMessage) {
      send({ type: 'sendFailed', message: SEND_FAILED_MESSAGE });
      return;
    }
    try {
      await sendMessage(reviewIssuesPrompt(context, issues));
      send({ type: 'sent' });
    } catch (err) {
      send({
        type: 'sendFailed',
        message:
          err instanceof MessageTooLongError
            ? TOO_LONG_MESSAGE
            : SEND_FAILED_MESSAGE,
      });
    }
  }

  const [state, send] = useMachine<ViewState, ViewEvent, ViewEffect>(
    viewTransition,
    initialViewState,
    (effect, send) => {
      switch (effect.type) {
        case 'fetchPage': {
          const loading = readPage(effect.request).then((event) => {
            send({ type: 'list', event });
            return event;
          });
          if (effect.request.cursor === null) {
            firstPage.current = loading;
            void loading.then(() => {
              if (firstPage.current === loading) firstPage.current = undefined;
            });
          }
          break;
        }
        case 'sendMessage':
          void handOff(effect.issues, send);
          break;
        // Best effort: the selection is also in the Review message, and a
        // failed update has nothing the user could do about it.
        case 'shareSelection':
          updateModelContext?.(selectionContext(effect.selection)).catch(
            () => {}
          );
          break;
        case 'clearModelContext':
          updateModelContext?.({ content: [] }).catch(() => {});
          break;
      }
    }
  );
  // The tool call that opened the view settles the opening listing.
  const canFetch = !!callTool;
  useEffect(() => {
    const result = delivered?.result;
    if (result) {
      send({
        type: 'list',
        event: {
          type: 'delivered',
          page: result.data.page,
          dropped: result.dropped,
          canFetch,
        },
      });
    } else if (openFailure !== undefined) {
      send({
        type: 'list',
        event: { type: 'openFailed', reason: openFailure },
      });
    }
  }, [delivered, openFailure, canFetch, send]);

  // The visible page is view state: Previous and Next move it, and the list
  // machine only learns that more rows are needed (`more`).
  const [page, setPage] = useState(0);
  const pageSize = pageSizeFor(hostContext?.containerDimensions);
  const list =
    state.status === 'active'
      ? presentList(state.list.listing, page, pageSize)
      : undefined;

  // Next past the loaded rows (or a smaller page size) needs the next server
  // page. A failed tail doesn't ask again by itself: Refresh starts over.
  const needsMore = !!list?.needsMore;
  useEffect(() => {
    if (needsMore) send({ type: 'list', event: { type: 'more' } });
  }, [needsMore, send]);

  // A newer issues view of this project retires this one.
  const opened = delivered?.result?.data.opened;
  const superseded = useSupersession(
    { view: VIEW_NAME, project: opened?.project },
    opened?.at
  );
  useEffect(() => {
    if (superseded) send({ type: 'retire' });
  }, [superseded, send]);

  if (state.status === 'retired' || !list) return { status: 'retired' };

  const { listing } = state.list;

  const startOver = () => {
    setPage(0);
    send({ type: 'list', event: { type: 'refresh' } });
  };

  const reload: Reload = async () => {
    const before = listingCount(listing);
    startOver();
    // The refresh's fetch, or the first-page fetch already in flight.
    const loading = firstPage.current;
    if (!loading) throw new Error('The issues view did not reload.');
    const outcome = await loading;
    if (outcome.type === 'pageFailed') throw new Error(outcome.message);
    const { page } = outcome;
    return {
      before,
      after:
        page.total ??
        (page.next_cursor === null ? page.issues.length : undefined),
    };
  };

  const server: ServerAccess = callTool
    ? { kind: 'tools', refresh: startOver, reload }
    : { kind: 'delivered' };

  const review: ReviewAction | undefined = sendMessage
    ? {
        kind: 'message',
        handoff: state.handoff,
        review: () => send({ type: 'review' }),
      }
    : updateModelContext
      ? { kind: 'hint' }
      : undefined;

  return {
    status: 'active',
    type,
    list,
    previous: () => setPage(Math.max(0, list.page - 1)),
    next: () => setPage(list.page + 1),
    selecting: review && {
      selection: state.selection,
      toggle: (issue) => send({ type: 'toggled', issue }),
      clear: () => send({ type: 'cleared' }),
      review,
    },
    server,
  };
}
