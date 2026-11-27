import { describe, expect, it } from 'vitest';
import type { Handoff } from './handoff';
import type { IssueSummary } from './issues-schema';
import { emptySelection, issueKey } from './selection';
import {
  initialViewState,
  type ViewEvent,
  type ViewState,
  viewTransition,
} from './view-state';

const issue: IssueSummary = {
  id: 'rls_disabled_in_public',
  category: 'security',
  title: 'RLS disabled in public',
  severity: 'critical',
  affected_count: 3,
};

/** Runs events in order; a refused one throws. */
function run(state: ViewState, ...events: ViewEvent[]) {
  let effects: unknown[] = [];
  for (const event of events) {
    const next = viewTransition(state, event);
    if (!next) throw new Error(`${event.type} not allowed`);
    state = next.state;
    effects = next.effects ?? [];
  }
  return { state, effects };
}

const active = (state: ViewState) => {
  if (state.status !== 'active') throw new Error('retired');
  return state;
};

const toggle: ViewEvent = { type: 'toggled', issue };

/** One issue selected, with the handoff in `handoff`. */
const selectedWith = (handoff: Handoff): ViewState => ({
  ...active(run(initialViewState, toggle).state),
  handoff,
});
const sending = selectedWith({ status: 'sending' });

describe('view state', () => {
  it('runs the list machine and passes its effects on', () => {
    const { state, effects } = run(initialViewState, {
      type: 'list',
      event: { type: 'refresh' },
    });
    expect(active(state).list.listing).toEqual({ status: 'loading' });
    expect(effects).toEqual([
      {
        type: 'fetchPage',
        request: { id: 1, cursor: null },
      },
    ]);
  });

  it('refuses what the list machine refuses', () => {
    expect(
      viewTransition(initialViewState, {
        type: 'list',
        event: { type: 'more' },
      })
    ).toBeNull();
  });

  describe('selection', () => {
    it('shares every change with the model', () => {
      const once = run(initialViewState, toggle);
      const { selection } = active(once.state);
      expect(selection.has(issueKey(issue))).toBe(true);
      expect(once.effects).toEqual([{ type: 'shareSelection', selection }]);

      const twice = run(once.state, toggle);
      expect(active(twice.state).selection.size).toBe(0);
      expect(twice.effects).toEqual([
        { type: 'shareSelection', selection: active(twice.state).selection },
      ]);

      const cleared = run(once.state, { type: 'cleared' });
      expect(active(cleared.state).selection).toBe(emptySelection);
      expect(cleared.effects).toEqual([
        { type: 'shareSelection', selection: emptySelection },
      ]);
    });

    it('shares nothing when clearing an empty selection', () => {
      expect(viewTransition(initialViewState, { type: 'cleared' })).toBeNull();
    });
  });

  describe('handoff', () => {
    it.each<[string, Handoff]>([
      ['idle', { status: 'idle' }],
      ['handed', { status: 'handed' }],
      ['failed', { status: 'failed', message: 'x' }],
    ])('sends the selected issues from %s', (_, handoff) => {
      const { state, effects } = run(selectedWith(handoff), {
        type: 'review',
      });
      expect(active(state).handoff).toEqual({ status: 'sending' });
      expect(effects).toEqual([{ type: 'sendMessage', issues: [issue] }]);
    });

    it('sends nothing with nothing selected', () => {
      expect(viewTransition(initialViewState, { type: 'review' })).toBeNull();
    });

    it('sends one message at a time', () => {
      expect(viewTransition(sending, { type: 'review' })).toBeNull();
    });

    it('clears and shares the selection once the message is handed over', () => {
      const { state, effects } = run(sending, { type: 'sent' });
      expect(active(state).handoff).toEqual({ status: 'handed' });
      expect(active(state).selection).toBe(emptySelection);
      expect(effects).toEqual([
        { type: 'shareSelection', selection: emptySelection },
      ]);
    });

    it('shares nothing when the selection was emptied while sending', () => {
      const emptied = run(sending, toggle).state;
      const { state, effects } = run(emptied, { type: 'sent' });
      expect(active(state).handoff).toEqual({ status: 'handed' });
      expect(effects).toEqual([]);
    });

    it('keeps the selection when the send fails', () => {
      const { state, effects } = run(sending, {
        type: 'sendFailed',
        message: 'Too long',
      });
      expect(active(state).handoff).toEqual({
        status: 'failed',
        message: 'Too long',
      });
      expect(active(state).selection.has(issueKey(issue))).toBe(true);
      expect(effects).toEqual([]);
    });

    it('ignores results when nothing is sending', () => {
      const idle = initialViewState;
      expect(viewTransition(idle, { type: 'sent' })).toBeNull();
      expect(
        viewTransition(idle, { type: 'sendFailed', message: 'x' })
      ).toBeNull();
    });
  });

  it('retires, dropping the list, the selection and the handoff, and clears the model context', () => {
    const { state, effects } = run(initialViewState, toggle, {
      type: 'retire',
    });
    expect(state).toEqual({ status: 'retired' });
    expect(effects).toEqual([{ type: 'clearModelContext' }]);
  });

  it('refuses every event once retired', () => {
    const retired: ViewState = { status: 'retired' };
    for (const event of [
      toggle,
      { type: 'cleared' },
      { type: 'list', event: { type: 'refresh' } },
      {
        type: 'list',
        event: {
          type: 'pageLoaded',
          id: 1,
          page: { issues: [issue], checks: [], next_cursor: null },
          dropped: 0,
        },
      },
      { type: 'review' },
      { type: 'sent' },
      { type: 'retire' },
    ] satisfies ViewEvent[]) {
      expect(viewTransition(retired, event)).toBeNull();
    }
  });
});
