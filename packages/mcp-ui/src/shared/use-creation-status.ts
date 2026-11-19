import { useEffect } from 'react';
import { useAnnouncement } from './Announcer';
import type { ProjectCardBadge, ProjectCardNote } from './ProjectCard';
import type { ToolCallState } from './use-mcp-view';
import { type Transition, useMachine } from './use-machine';

export const POLL_INTERVAL_MS = 5000;
export const POLL_TIMEOUT_MS = 10 * 60 * 1000;
/** Consecutive failed reads tolerated before giving up with an error. */
export const POLL_MAX_RETRIES = 2;

/** Where the thing being created is, for one of its statuses. */
export type Progress =
  | { state: 'done' }
  /** On, or failed at, this index of the view's step labels. */
  | { state: 'step' | 'failed'; step: number }
  /** A status outside creation (paused, restarting, …), with its own label. */
  | {
      state: 'other';
      label: string;
      tone?: 'success' | 'warning';
      /** Whether it moves on by itself, so the view keeps checking it. */
      isChanging: boolean;
    };

/** Why checking stopped without an answer. */
export type StopReason =
  | { type: 'timeout' }
  | { type: 'error'; message: string };

/**
 * Checking what a tool call created (the call's own status is separate).
 * `data` is the latest successful read: always there once settled, and there in
 * the other states once any read has succeeded. `round` numbers the stretches
 * of checking, so a result from an earlier one (before Retry) is recognised
 * and dropped.
 */
export type Checking<T> =
  /** Nothing to check yet (no tool result, or the host can't read it). */
  | { status: 'idle' }
  /** Reading now and then, until the status is final. */
  | {
      status: 'following';
      round: number;
      data?: T;
      /** Consecutive failed reads. */
      failures: number;
      startedAt: number;
    }
  /** The status is final (done or failed). */
  | { status: 'settled'; data: T }
  /** Checking gave up; Retry is offered. */
  | { status: 'stopped'; round: number; data?: T; reason: StopReason }
  /** Retry's read is in flight; the reason it replaces stays shown. */
  | { status: 'retrying'; round: number; data?: T; reason: StopReason };

export type CheckingEvent<T> =
  | { type: 'start'; at: number }
  /** `terminal`: the status read is final (done or failed). */
  | { type: 'read'; round: number; data: T; terminal: boolean; at: number }
  | { type: 'readFailed'; round: number; message: string; at: number }
  | { type: 'retry' }
  | { type: 'retryRead'; round: number; data: T; terminal: boolean; at: number }
  | { type: 'retryFailed'; round: number; message: string };

export type CheckingEffect =
  /** Read after `delayMs` (0 for now); cancelled if the view goes away. */
  | { type: 'read'; round: number; delayMs: number }
  /** Read once now, for Retry. */
  | { type: 'readOnce'; round: number };

/** The next tick would pass the timeout. */
const outOfTime = (startedAt: number, at: number) =>
  at - startedAt + POLL_INTERVAL_MS >= POLL_TIMEOUT_MS;

const dataOf = <T>(state: Checking<T>): T | undefined =>
  state.status === 'idle' ? undefined : state.data;

/** Events carry the `round` they belong to; others are dropped (`null`). */
export function checkingTransition<T>(
  state: Checking<T>,
  event: CheckingEvent<T>
): { state: Checking<T>; effects?: CheckingEffect[] } | null {
  switch (event.type) {
    case 'start':
      if (state.status !== 'idle') return null;
      return {
        state: {
          status: 'following',
          round: 1,
          failures: 0,
          startedAt: event.at,
        },
        effects: [{ type: 'read', round: 1, delayMs: 0 }],
      };
    case 'read': {
      if (state.status !== 'following' || event.round !== state.round) {
        return null;
      }
      if (event.terminal) {
        return { state: { status: 'settled', data: event.data } };
      }
      if (outOfTime(state.startedAt, event.at)) {
        return {
          state: {
            status: 'stopped',
            round: state.round,
            data: event.data,
            reason: { type: 'timeout' },
          },
        };
      }
      return {
        state: { ...state, data: event.data, failures: 0 },
        effects: [
          { type: 'read', round: state.round, delayMs: POLL_INTERVAL_MS },
        ],
      };
    }
    case 'readFailed': {
      if (state.status !== 'following' || event.round !== state.round) {
        return null;
      }
      const failures = state.failures + 1;
      if (failures > POLL_MAX_RETRIES) {
        return {
          state: {
            status: 'stopped',
            round: state.round,
            data: state.data,
            reason: { type: 'error', message: event.message },
          },
        };
      }
      if (outOfTime(state.startedAt, event.at)) {
        return {
          state: {
            status: 'stopped',
            round: state.round,
            data: state.data,
            reason: { type: 'timeout' },
          },
        };
      }
      return {
        state: { ...state, failures },
        effects: [
          { type: 'read', round: state.round, delayMs: POLL_INTERVAL_MS },
        ],
      };
    }
    case 'retry':
      if (state.status !== 'stopped') return null;
      return {
        state: { ...state, status: 'retrying' },
        effects: [{ type: 'readOnce', round: state.round }],
      };
    case 'retryRead': {
      if (state.status !== 'retrying' || event.round !== state.round) {
        return null;
      }
      if (event.terminal) {
        return { state: { status: 'settled', data: event.data } };
      }
      const round = state.round + 1;
      return {
        state: {
          status: 'following',
          round,
          data: event.data,
          failures: 0,
          startedAt: event.at,
        },
        // Like starting: the first read of the new round is immediate.
        effects: [{ type: 'read', round, delayMs: 0 }],
      };
    }
    case 'retryFailed':
      if (state.status !== 'retrying' || event.round !== state.round) {
        return null;
      }
      return {
        state: {
          status: 'stopped',
          round: state.round,
          data: state.data,
          reason: { type: 'error', message: event.message },
        },
      };
  }
}

/**
 * Follows what a tool call created (a project, a branch) until it's ready,
 * and says how `ProjectCard` should show it: the status badge, a note for a
 * problem or for why the status won't update, and Retry once checking has
 * stopped without an answer. Changes are announced to screen readers.
 */
export function useCreationStatus<T extends { status: string }>({
  noun,
  toolCall,
  canPollInitial,
  read,
  labels,
  progress,
  checkWith,
}: {
  /** What is being created, for announcements: "project" or "branch". */
  noun: string;
  toolCall: ToolCallState<T>;
  /**
   * False when the status can't be read, e.g. the host can't proxy tool
   * calls. Checking starts once this is true and there is a tool result; it
   * only matters until then: turning false later doesn't stop checking.
   */
  canPollInitial: boolean;
  /** Reads the latest version of what the tool call returned. */
  read: (created: T) => Promise<T>;
  /** The steps of creating it; `progress` returns indexes into these. */
  labels: string[];
  progress: (status: T['status']) => Progress;
  /** Tool the model can use to check the status when the view can't. */
  checkWith: string;
}) {
  const created = toolCall.status === 'ready' ? toolCall.data : undefined;

  const [checking, send] = useMachine(
    checkingTransition<T>,
    { status: 'idle' },
    (effect, send, done) => {
      async function readNow(
        ok: (data: T, terminal: boolean) => CheckingEvent<T>,
        fail: (message: string) => CheckingEvent<T>
      ) {
        let event: CheckingEvent<T>;
        try {
          const next = await read(created!);
          const { state } = progress(next.status);
          event = ok(next, state === 'done' || state === 'failed');
        } catch (error) {
          event = fail(error instanceof Error ? error.message : String(error));
        }
        send(event);
      }
      const { round } = effect;
      const at = () => Date.now();
      switch (effect.type) {
        case 'read': {
          const timer = setTimeout(() => {
            done();
            void readNow(
              (data, terminal) => ({
                type: 'read',
                round,
                data,
                terminal,
                at: at(),
              }),
              (message) => ({ type: 'readFailed', round, message, at: at() })
            );
          }, effect.delayMs);
          return () => clearTimeout(timer);
        }
        case 'readOnce':
          void readNow(
            (data, terminal) => ({
              type: 'retryRead',
              round,
              data,
              terminal,
              at: at(),
            }),
            (message) => ({ type: 'retryFailed', round, message })
          );
          return;
      }
    }
  );

  // Starts once there is a tool result to check and the host can read it.
  useEffect(() => {
    if (canPollInitial && created) send({ type: 'start', at: Date.now() });
  }, [canPollInitial, created, send]);

  const data = dataOf(checking) ?? created;
  const isRetrying = checking.status === 'retrying';
  const stopReason =
    checking.status === 'stopped' || checking.status === 'retrying'
      ? checking.reason
      : undefined;

  const current = data ? progress(data.status) : undefined;
  const isFollowing = checking.status === 'following';
  const isChanging =
    current?.state === 'step' ||
    (current?.state === 'other' && current.isChanging);

  const checkError =
    stopReason?.type === 'error' ? stopReason.message : undefined;

  // No tool result yet (the host may still be asking the user to confirm): the
  // card shows the call's arguments, if sent, and skeletons for the rest.
  const isLoading = toolCall.status === 'loading';

  let badge: ProjectCardBadge | undefined;
  let note: ProjectCardNote | undefined;
  // What screen readers hear when it changes; danger notes are announced
  // assertively on their own.
  let announcement: string;
  if (isLoading) {
    announcement = `Loading ${noun}`;
  } else if (toolCall.status === 'error') {
    badge = { label: 'Failed', tone: 'danger' };
    note = { tone: 'danger', text: toolCall.message };
    announcement = 'Failed';
  } else if (toolCall.status === 'cancelled') {
    badge = { label: 'Cancelled' };
    note = toolCall.reason
      ? { tone: 'muted', text: toolCall.reason }
      : undefined;
    announcement = 'Cancelled';
  } else if (checkError) {
    // A failed check replaces the status: the last one read may no longer be true.
    badge = {
      label: 'Check failed',
      tone: 'danger',
      title: `Failed to check status: ${checkError}`,
    };
    note = { tone: 'danger', text: `Can't check status: ${checkError}.` };
    announcement = 'Check failed';
  } else if (current?.state === 'done') {
    badge = { label: 'Active', tone: 'success' };
    announcement = 'Active';
  } else if (current?.state === 'failed') {
    badge = { label: 'Failed', tone: 'danger' };
    note = {
      tone: 'danger',
      text: `Failed while ${labels[current.step]!.toLowerCase()} (${data!.status}).`,
    };
    announcement = 'Failed';
  } else if (current?.state === 'step') {
    // Neutral, with the spinner saying it's in progress: hosts' warning
    // colours vary (Codex's is orange-red) and read as a problem.
    const label = labels[current.step]!;
    badge = { label, isSpinning: isFollowing };
    announcement = `${label}, step ${current.step + 1} of ${labels.length}`;
  } else {
    const { label, tone, isChanging } = current as Extract<
      Progress,
      { state: 'other' }
    >;
    badge = { label, tone, isSpinning: isChanging && isFollowing };
    announcement = label;
  }

  if (toolCall.status === 'ready' && !note) {
    if (stopReason?.type === 'timeout') {
      note = { tone: 'muted', text: 'Stopped checking after 10 minutes.' };
    } else if (!canPollInitial && isChanging) {
      note = {
        tone: 'muted',
        text: `Status won't update here. Ask the assistant to check with ${checkWith}.`,
      };
    }
  }

  useAnnouncement(
    note?.tone === 'muted' ? `${announcement}. ${note.text}` : announcement
  );
  useAnnouncement(note?.tone === 'danger' ? note.text : undefined, 'assertive');

  // Checking stopped without an answer (the checks kept failing, or the
  // timeout passed) and can start again.
  const canRetry =
    toolCall.status === 'ready' &&
    canPollInitial &&
    (checking.status === 'stopped' || isRetrying);

  return {
    /** The latest read, or what the tool call returned until there is one. */
    data,
    isLoading,
    isDone: current?.state === 'done',
    badge,
    note,
    onRetry: canRetry ? () => send({ type: 'retry' }) : undefined,
    isRetrying,
  };
}
