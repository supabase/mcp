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
 * `run` may return a cleanup (e.g. clear a timer) for work that can still be
 * cancelled. `useMachine` calls the cleanups still pending when the component
 * unmounts; after that, `send` ignores events, so a fetch resolving late can't
 * set state. Call `done` once the work no longer needs cancelling (a timer
 * that fired) so finished effects aren't kept: long-running machines don't
 * accumulate them. Under React Strict Mode's simulated unmount and remount,
 * effects with a pending cleanup are run again, so they aren't lost.
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
  run: (
    effect: Effect,
    send: (event: Event) => void,
    done: () => void
  ) => void | (() => void)
): [State, (event: Event) => void] {
  const [state, setState] = useState(initial);
  const current = useRef(initial);

  // Latest `run`, so it can close over fresh props without changing `send`.
  const runner = useRef(run);
  useEffect(() => {
    runner.current = run;
  });

  const isMounted = useRef(true);
  /** Effects with cleanups still pending. */
  const pending = useRef(new Set<{ effect: Effect; cleanup: () => void }>());
  /** Effects cleaned up by an unmount, to run again if it was only simulated. */
  const interrupted = useRef<Effect[]>([]);

  // Runs one effect, keeping its cleanup until it's done. Reads only refs, so
  // it never changes; `send` is passed in because it is defined below.
  const execute = useCallback(
    (effect: Effect, send: (event: Event) => void) => {
      let finished = false;
      let entry: { effect: Effect; cleanup: () => void } | undefined;
      const done = () => {
        finished = true;
        if (entry) pending.current.delete(entry);
      };
      const cleanup = runner.current(effect, send, done);
      if (cleanup && !finished) {
        entry = { effect, cleanup };
        pending.current.add(entry);
      }
    },
    []
  );

  const send = useCallback(
    (event: Event) => {
      if (!isMounted.current) return;
      const next = transition(current.current, event);
      if (!next) return;
      current.current = next.state;
      setState(next.state);
      for (const effect of next.effects ?? []) execute(effect, send);
    },
    [transition, execute]
  );

  // `send` only changes with `transition`, which must be stable, so this runs
  // on mount and unmount (twice each under Strict Mode).
  useEffect(() => {
    isMounted.current = true;
    for (const effect of interrupted.current.splice(0)) execute(effect, send);
    const entries = pending.current;
    return () => {
      isMounted.current = false;
      for (const entry of entries) {
        entry.cleanup();
        interrupted.current.push(entry.effect);
      }
      entries.clear();
    };
  }, [execute, send]);

  return [state, send];
}
