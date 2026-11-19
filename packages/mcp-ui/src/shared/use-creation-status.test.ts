import { describe, expect, it } from 'vitest';
import {
  type Checking,
  type CheckingEvent,
  checkingTransition,
  POLL_INTERVAL_MS,
  POLL_MAX_RETRIES,
  POLL_TIMEOUT_MS,
} from './use-creation-status';

type Data = number;
type State = Checking<Data>;

const following = (
  over: Partial<Extract<State, { status: 'following' }>> = {}
) =>
  ({
    status: 'following',
    round: 1,
    failures: 0,
    startedAt: 0,
    ...over,
  }) as State;

const read = (
  data: Data,
  at = 0,
  over: Partial<Extract<CheckingEvent<Data>, { type: 'read' }>> = {}
): CheckingEvent<Data> => ({
  type: 'read',
  round: 1,
  data,
  terminal: false,
  at,
  ...over,
});
const failed = (at = 0, round = 1): CheckingEvent<Data> => ({
  type: 'readFailed',
  round,
  message: 'down',
  at,
});

const step = (state: State, event: CheckingEvent<Data>) =>
  checkingTransition<Data>(state, event);

describe('checkingTransition', () => {
  it('starts with an immediate read, once', () => {
    const next = step({ status: 'idle' }, { type: 'start', at: 5 });
    expect(next).toEqual({
      state: following({ startedAt: 5 }),
      effects: [{ type: 'read', round: 1, delayMs: 0 }],
    });
    expect(step(next!.state, { type: 'start', at: 6 })).toBeNull();
  });

  it('keeps the latest data and reads again after the interval', () => {
    expect(step(following(), read(1))).toEqual({
      state: following({ data: 1 }),
      effects: [{ type: 'read', round: 1, delayMs: POLL_INTERVAL_MS }],
    });
  });

  it('settles on a terminal read, for good', () => {
    const next = step(following(), read(3, 0, { terminal: true }));
    expect(next).toEqual({ state: { status: 'settled', data: 3 } });
    expect(step(next!.state, read(4))).toBeNull();
    expect(step(next!.state, failed())).toBeNull();
    expect(step(next!.state, { type: 'retry' })).toBeNull();
  });

  it('tolerates failures, keeping data, and resets the count on success', () => {
    let state = following({ data: 1 });
    for (let i = 1; i <= POLL_MAX_RETRIES; i++) {
      const next = step(state, failed());
      expect(next?.effects).toEqual([
        { type: 'read', round: 1, delayMs: POLL_INTERVAL_MS },
      ]);
      state = next!.state;
      expect(state).toMatchObject({
        status: 'following',
        data: 1,
        failures: i,
      });
    }
    expect(step(state, read(2))?.state).toMatchObject({
      data: 2,
      failures: 0,
    });
  });

  it('stops with the error after too many consecutive failures, keeping data', () => {
    const next = step(
      following({ data: 1, failures: POLL_MAX_RETRIES }),
      failed()
    );
    expect(next).toEqual({
      state: {
        status: 'stopped',
        round: 1,
        data: 1,
        reason: { type: 'error', message: 'down' },
      },
    });
  });

  it('times out when the next tick would pass the timeout', () => {
    const justBefore = POLL_TIMEOUT_MS - POLL_INTERVAL_MS - 1;
    expect(step(following(), read(1, justBefore))?.state.status).toBe(
      'following'
    );
    const stopped = {
      status: 'stopped',
      round: 1,
      data: 1,
      reason: { type: 'timeout' },
    };
    expect(
      step(following(), read(1, POLL_TIMEOUT_MS - POLL_INTERVAL_MS))
    ).toEqual({ state: stopped });
    // Also after a tolerated failure.
    expect(
      step(following({ data: 1 }), failed(POLL_TIMEOUT_MS - POLL_INTERVAL_MS))
    ).toEqual({ state: stopped });
  });

  it('a terminal read wins over the timeout', () => {
    expect(
      step(following(), read(3, POLL_TIMEOUT_MS, { terminal: true }))?.state
        .status
    ).toBe('settled');
  });

  it('ignores results from another round or state', () => {
    expect(step(following({ round: 2 }), read(1))).toBeNull();
    expect(step(following({ round: 2 }), failed())).toBeNull();
    expect(step({ status: 'idle' }, read(1))).toBeNull();
  });

  describe('Retry', () => {
    const stopped: State = {
      status: 'stopped',
      round: 1,
      data: 1,
      reason: { type: 'error', message: 'down' },
    };

    it('is only allowed once stopped, and reads once', () => {
      expect(step(following(), { type: 'retry' })).toBeNull();
      expect(step({ status: 'idle' }, { type: 'retry' })).toBeNull();
      const next = step(stopped, { type: 'retry' });
      expect(next).toEqual({
        state: { ...stopped, status: 'retrying' },
        effects: [{ type: 'readOnce', round: 1 }],
      });
      // Not again while in flight.
      expect(step(next!.state, { type: 'retry' })).toBeNull();
    });

    it('follows again in a new round with fresh timing on success', () => {
      const retrying = step(stopped, { type: 'retry' })!.state;
      const next = step(retrying, {
        type: 'retryRead',
        round: 1,
        data: 2,
        terminal: false,
        at: 99,
      });
      expect(next).toEqual({
        state: following({ round: 2, data: 2, startedAt: 99 }),
        effects: [{ type: 'read', round: 2, delayMs: 0 }],
      });
      // The old round's results are dropped.
      expect(step(next!.state, read(7))).toBeNull();
    });

    it('settles on a terminal retry read', () => {
      const retrying = step(stopped, { type: 'retry' })!.state;
      expect(
        step(retrying, {
          type: 'retryRead',
          round: 1,
          data: 3,
          terminal: true,
          at: 0,
        })
      ).toEqual({ state: { status: 'settled', data: 3 } });
    });

    it('goes back to stopped with the new error on failure', () => {
      const retrying = step(stopped, { type: 'retry' })!.state;
      expect(
        step(retrying, { type: 'retryFailed', round: 1, message: 'still down' })
      ).toEqual({
        state: {
          ...stopped,
          reason: { type: 'error', message: 'still down' },
        },
      });
    });

    it('ignores a stale retry result', () => {
      const retrying = step(stopped, { type: 'retry' })!.state;
      expect(
        step(retrying, {
          type: 'retryRead',
          round: 0,
          data: 2,
          terminal: false,
          at: 0,
        })
      ).toBeNull();
    });
  });
});
