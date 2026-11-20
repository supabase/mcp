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
    delayMs: 0,
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
    expect(next).toEqual(following({ startedAt: 5 }));
    expect(step(next, { type: 'start', at: 6 })).toBe(next);
  });

  it('keeps the latest data and reads again after the interval', () => {
    expect(step(following(), read(1))).toEqual(
      following({ data: 1, delayMs: POLL_INTERVAL_MS })
    );
  });

  it('settles on a terminal read, for good', () => {
    const next = step(following(), read(3, 0, { terminal: true }));
    expect(next).toEqual({ status: 'settled', data: 3 });
    expect(step(next, read(4))).toBe(next);
    expect(step(next, failed())).toBe(next);
    expect(step(next, { type: 'retry' })).toBe(next);
  });

  it('tolerates failures, keeping data, and resets the count on success', () => {
    let state = following({ data: 1 });
    for (let i = 1; i <= POLL_MAX_RETRIES; i++) {
      state = step(state, failed());
      expect(state).toEqual(
        following({ data: 1, failures: i, delayMs: POLL_INTERVAL_MS })
      );
    }
    expect(step(state, read(2))).toMatchObject({ data: 2, failures: 0 });
  });

  it('stops with the error after too many consecutive failures, keeping data', () => {
    const next = step(
      following({ data: 1, failures: POLL_MAX_RETRIES }),
      failed()
    );
    expect(next).toEqual({
      status: 'stopped',
      data: 1,
      reason: { type: 'error', message: 'down' },
    });
  });

  it('times out when the next tick would pass the timeout', () => {
    const justBefore = POLL_TIMEOUT_MS - POLL_INTERVAL_MS - 1;
    expect(step(following(), read(1, justBefore)).status).toBe('following');
    const stopped = {
      status: 'stopped',
      data: 1,
      reason: { type: 'timeout' },
    };
    expect(
      step(following(), read(1, POLL_TIMEOUT_MS - POLL_INTERVAL_MS))
    ).toEqual(stopped);
    // Also after a tolerated failure.
    expect(
      step(following({ data: 1 }), failed(POLL_TIMEOUT_MS - POLL_INTERVAL_MS))
    ).toEqual(stopped);
  });

  it('a terminal read wins over the timeout', () => {
    expect(
      step(following(), read(3, POLL_TIMEOUT_MS, { terminal: true })).status
    ).toBe('settled');
  });

  it('ignores results when nothing is being read', () => {
    const idle: State = { status: 'idle' };
    expect(step(idle, read(1))).toBe(idle);
    expect(step(idle, failed())).toBe(idle);
  });

  describe('Retry', () => {
    const stopped: State = {
      status: 'stopped',
      data: 1,
      reason: { type: 'error', message: 'down' },
    };

    it('is only allowed once stopped', () => {
      const running = following();
      const idle: State = { status: 'idle' };
      expect(step(running, { type: 'retry' })).toBe(running);
      expect(step(idle, { type: 'retry' })).toBe(idle);
      const next = step(stopped, { type: 'retry' });
      expect(next).toEqual({ ...stopped, status: 'retrying' });
      // Not again while in flight.
      expect(step(next, { type: 'retry' })).toBe(next);
    });

    it('follows again with fresh timing on success', () => {
      const retrying = step(stopped, { type: 'retry' });
      expect(step(retrying, read(2, 99))).toEqual(
        following({ data: 2, startedAt: 99 })
      );
    });

    it('settles on a terminal retry read', () => {
      const retrying = step(stopped, { type: 'retry' });
      expect(step(retrying, read(3, 0, { terminal: true }))).toEqual({
        status: 'settled',
        data: 3,
      });
    });

    it('goes back to stopped with the new error on failure', () => {
      const retrying = step(stopped, { type: 'retry' });
      expect(
        step(retrying, { type: 'readFailed', message: 'still down', at: 0 })
      ).toEqual({
        ...stopped,
        reason: { type: 'error', message: 'still down' },
      });
    });
  });
});
