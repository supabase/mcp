import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A state machine step: the next state and the effects to run on entering it,
 * or `null` when the event isn't allowed in `state`. Then nothing changes and
 * nothing runs, so a disallowed event can't start work.
 *
 * Pure: effects are data, run by `useMachine`.
 */
export type Transition<State, Event, Effect> = (
  state: State,
  event: Event
) => { state: State; effects?: Effect[] } | null;

/**
 * Like `useReducer`, but each transition also says what to do next. `run`
 * performs an effect and may `send` follow-up events (e.g. a fetch's result).
 *
 * Transitions read the machine's current state synchronously, not the last
 * rendered one, so two events in quick succession (a double click) see each
 * other.
 *
 * `transition` must be stable (e.g. defined at module level): `send` changes
 * identity whenever it does. `run` may change every render.
 */
export function useMachine<State, Event, Effect>(
  transition: Transition<State, Event, Effect>,
  initial: State,
  run: (effect: Effect, send: (event: Event) => void) => void
): [State, (event: Event) => void] {
  const [state, setState] = useState(initial);
  const current = useRef(initial);

  // Latest `run`, so it can close over fresh props without changing `send`.
  const runner = useRef(run);
  useEffect(() => {
    runner.current = run;
  });

  const send = useCallback(
    (event: Event) => {
      const next = transition(current.current, event);
      if (!next) return;
      current.current = next.state;
      setState(next.state);
      for (const effect of next.effects ?? []) runner.current(effect, send);
    },
    [transition]
  );

  return [state, send];
}
