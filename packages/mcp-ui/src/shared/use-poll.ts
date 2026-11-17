import { useCallback, useEffect, useRef, useState } from 'react';

export const POLL_INTERVAL_MS = 5000;
export const POLL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Where polling is. `data` is the latest successful result: always there once
 * done, and there in the other states once any poll has succeeded (after an
 * error, it's the result from before the error).
 */
export type PollStatus<T> =
  | { status: 'running'; data?: T }
  | { status: 'done'; data: T }
  | { status: 'timeout'; data?: T }
  | { status: 'error'; error: Error; data?: T };

export type PollState<T> = PollStatus<T> & {
  /** Restarts polling with a fresh timeout. */
  retry: () => void;
};

/**
 * Calls `fetcher` immediately and then every `intervalMs` (default
 * `POLL_INTERVAL_MS`) until `isTerminal` returns true, the fetcher throws,
 * `timeoutMs` (default `POLL_TIMEOUT_MS`) passes, or the component unmounts. `enabled` false pauses everything (e.g. before the app connects).
 *
 * `fetcher` and `isTerminal` may change identity every render.
 */
export function usePoll<T>({
  fetcher,
  isTerminal,
  enabled = true,
  intervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
}: {
  fetcher: () => Promise<T>;
  isTerminal: (data: T) => boolean;
  enabled?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
}): PollState<T> {
  const [state, setState] = useState<PollStatus<T>>({ status: 'running' });
  const [run, setRun] = useState(0);

  const callbacks = useRef({ fetcher, isTerminal });
  useEffect(() => {
    callbacks.current = { fetcher, isTerminal };
  });

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    // Keep the last result on a retry, so progress doesn't jump back.
    setState((current) => ({ status: 'running', data: current.data }));

    const tick = async () => {
      let next: T;
      try {
        next = await callbacks.current.fetcher();
      } catch (err) {
        if (stopped) return;
        setState((current) => ({
          status: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
          data: current.data,
        }));
        return;
      }
      if (stopped) return;
      if (callbacks.current.isTerminal(next)) {
        setState({ status: 'done', data: next });
        return;
      }
      if (Date.now() - startedAt + intervalMs >= timeoutMs) {
        setState({ status: 'timeout', data: next });
        return;
      }
      setState({ status: 'running', data: next });
      timer = setTimeout(tick, intervalMs);
    };
    void tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, intervalMs, timeoutMs, run]);

  const retry = useCallback(() => setRun((n) => n + 1), []);

  return { ...state, retry };
}
