/**
 * The issues view's top-level state. Active, it holds the list, the
 * selection and the handoff. Retired, once a newer issues view of the same
 * project has opened (`shared/use-supersession.ts`), it holds none of them:
 * a retired view cannot fetch, send a prompt or share a selection, because
 * every event but the one that retires it is refused. No flag has to be
 * checked before each call. Pure: the wiring runs the effects, and reports a
 * handoff's result with `sent` or `sendFailed`.
 */
import type { Transition } from '../../shared/use-machine';
import { type Handoff, initialHandoff } from './handoff';
import {
  type Effect as ListEffect,
  type Event as ListEvent,
  initialIssuesList,
  issuesListTransition,
  type State as ListState,
} from './issues-list';
import type { IssueSummary } from './issues-schema';
import {
  emptySelection,
  type Selection,
  type SelectionEvent,
  selectionReducer,
} from './selection';

export type ViewState =
  | {
      status: 'active';
      list: ListState;
      selection: Selection;
      handoff: Handoff;
    }
  | { status: 'retired' };

type ActiveState = Extract<ViewState, { status: 'active' }>;

export type ViewEvent =
  | { type: 'list'; event: ListEvent }
  | SelectionEvent
  /** The user pressed Review: hand the selected issues to the assistant. */
  | { type: 'review' }
  | { type: 'sent' }
  | { type: 'sendFailed'; message: string }
  /** A newer issues view of the same project has opened. */
  | { type: 'retire' };

export type ViewEffect =
  | ListEffect
  | { type: 'sendMessage'; issues: IssueSummary[] }
  /**
   * Share the whole selection with the model: each update replaces the last,
   * and an empty one clears it.
   */
  | { type: 'shareSelection'; selection: Selection }
  /** The view is no longer current: take back what it shared with the model. */
  | { type: 'clearModelContext' };

export const initialViewState: ViewState = {
  status: 'active',
  list: initialIssuesList,
  selection: emptySelection,
  handoff: initialHandoff,
};

/** Enters `state`, whose selection changed, and shares it. */
const selected = (state: ActiveState) => ({
  state,
  effects: [{ type: 'shareSelection', selection: state.selection } as const],
});

export const viewTransition: Transition<ViewState, ViewEvent, ViewEffect> = (
  state,
  event
) => {
  if (state.status === 'retired') return null;
  switch (event.type) {
    case 'list': {
      const next = issuesListTransition(state.list, event.event);
      if (!next) return null;
      return { state: { ...state, list: next.state }, effects: next.effects };
    }
    case 'toggled':
    case 'cleared': {
      const selection = selectionReducer(state.selection, event);
      if (selection === state.selection) return null;
      return selected({ ...state, selection });
    }
    case 'review':
      // One send at a time, and only with something to send.
      if (state.handoff.status === 'sending' || !state.selection.size) {
        return null;
      }
      return {
        state: { ...state, handoff: { status: 'sending' } },
        effects: [
          { type: 'sendMessage', issues: [...state.selection.values()] },
        ],
      };
    case 'sent': {
      if (state.handoff.status !== 'sending') return null;
      const handed: ActiveState = { ...state, handoff: { status: 'handed' } };
      // On success only: on failure the selection stays for another try.
      return state.selection.size
        ? selected({ ...handed, selection: emptySelection })
        : { state: handed };
    }
    case 'sendFailed':
      if (state.handoff.status !== 'sending') return null;
      return {
        state: {
          ...state,
          handoff: { status: 'failed', message: event.message },
        },
      };
    case 'retire':
      return {
        state: { status: 'retired' },
        effects: [{ type: 'clearModelContext' }],
      };
  }
};
