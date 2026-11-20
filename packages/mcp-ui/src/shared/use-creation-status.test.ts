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
  data,
  terminal: false,
  at,
  ...over,
});
const failed = (at = 0): CheckingEvent<Data> => ({
  type: 'readFailed',
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
      effects: [{ type: 'read', delayMs: 0 }],
    });
    expect(step(next!.state, { type: 'start', at: 6 })).toBeNull();
  });

  it('keeps the latest data and reads again after the interval', () => {
    expect(step(following(), read(1))).toEqual({
      state: following({ data: 1 }),
      effects: [{ type: 'read', delayMs: POLL_INTERVAL_MS }],
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
        { type: 'read', delayMs: POLL_INTERVAL_MS },
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

  it('ignores results when nothing is being read', () => {
    expect(step({ status: 'idle' }, read(1))).toBeNull();
    expect(step({ status: 'idle' }, failed())).toBeNull();
  });

  describe('Retry', () => {
    const stopped: State = {
      status: 'stopped',
      data: 1,
      reason: { type: 'error', message: 'down' },
    };

    it('is only allowed once stopped, and reads once', () => {
      expect(step(following(), { type: 'retry' })).toBeNull();
      expect(step({ status: 'idle' }, { type: 'retry' })).toBeNull();
      const next = step(stopped, { type: 'retry' });
      expect(next).toEqual({
        state: { ...stopped, status: 'retrying' },
        effects: [{ type: 'read', delayMs: 0 }],
      });
      // Not again while in flight.
      expect(step(next!.state, { type: 'retry' })).toBeNull();
    });

    it('follows again with fresh timing on success', () => {
      const retrying = step(stopped, { type: 'retry' })!.state;
      expect(step(retrying, read(2, 99))).toEqual({
        state: following({ data: 2, startedAt: 99 }),
        effects: [{ type: 'read', delayMs: 0 }],
      });
    });

    it('settles on a terminal retry read', () => {
      const retrying = step(stopped, { type: 'retry' })!.state;
      expect(step(retrying, read(3, 0, { terminal: true }))).toEqual({
        state: { status: 'settled', data: 3 },
      });
    });

    it('goes back to stopped with the new error on failure', () => {
      const retrying = step(stopped, { type: 'retry' })!.state;
      expect(
        step(retrying, { type: 'readFailed', message: 'still down', at: 0 })
      ).toEqual({
        state: {
          ...stopped,
          reason: { type: 'error', message: 'still down' },
        },
      });
    });
  });
});
