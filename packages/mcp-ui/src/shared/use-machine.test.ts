import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type Transition, useMachine } from './use-machine';

type Event = { type: 'inc' } | { type: 'arm' } | { type: 'fire' };
type Effect = { type: 'timer' } | { type: 'plain' };

const transition: Transition<number, Event, Effect> = (state, event) => {
  switch (event.type) {
    case 'inc':
      return { state: state + 1 };
    case 'arm':
      return { state, effects: [{ type: 'timer' }] };
    case 'fire':
      return { state, effects: [{ type: 'plain' }] };
  }
};

describe('useMachine', () => {
  it('runs pending cleanups on unmount and ignores later events', () => {
    const cleanup = vi.fn();
    const ran = vi.fn();
    const { result, unmount } = renderHook(() =>
      useMachine(transition, 0, (effect) => {
        ran(effect.type);
        return effect.type === 'timer' ? cleanup : undefined;
      })
    );
    act(() => result.current[1]({ type: 'arm' }));
    act(() => result.current[1]({ type: 'fire' }));
    expect(ran).toHaveBeenCalledTimes(2);
    expect(cleanup).not.toHaveBeenCalled();

    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);

    result.current[1]({ type: 'fire' });
    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('forgets an effect that says it is done', () => {
    const cleanup = vi.fn();
    const { result, unmount } = renderHook(() =>
      useMachine(transition, 0, (_effect, _send, done) => {
        done();
        return cleanup;
      })
    );
    act(() => result.current[1]({ type: 'arm' }));
    unmount();
    expect(cleanup).not.toHaveBeenCalled();
  });
});
