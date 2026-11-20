import { useEffect, useEffectEvent, useReducer } from 'react';
import { useAnnouncement } from './Announcer';
import type { Tone } from './Badge';
import type { ProjectCardBadge, ProjectCardNote } from './ProjectCard';
import type { ToolCallState } from './use-mcp-view';

export const POLL_INTERVAL_MS = 5000;
export const POLL_TIMEOUT_MS = 10 * 60 * 1000;
/** Consecutive failed reads tolerated before giving up with an error. */
export const POLL_MAX_RETRIES = 2;

/** Where the thing being created is, for one of its statuses. */
export type Progress =
  | { state: 'done' }
  /** On a step of creating it: `step` of `of`, counting from 1. */
  | { state: 'step'; label: string; step: number; of: number }
  /** Failed `during` a step, named as `label` is. */
  | { state: 'failed'; during: string }
  /** A status outside creation (paused, restarting, …), with its own label. */
  | {
      state: 'other';
      label: string;
      tone?: Exclude<Tone, 'danger'>;
      /** Whether it moves on by itself, so the view keeps checking it. */
      isChanging: boolean;
    };

/** What a view says about the thing it creates; each view's `status.ts` has one. */
export type CreationConfig<T extends { status: string }> = {
  /** What is being created, for announcements: "project" or "branch". */
  noun: string;
  progress: (status: T['status']) => Progress;
  /** Tool the model can use to check the status when the view can't. */
  checkWith: string;
};

/** Why checking stopped without an answer. */
export type StopReason =
  | { type: 'timeout' }
  | { type: 'error'; message: string };

/**
 * Checking what a tool call created (the call's own status is separate).
 * `data` is the latest successful read: always there once settled, and there in
 * the other states once any read has succeeded. At most one read is in flight
 * at a time: the next is only scheduled once a result arrives, and checking
 * only stops on a result, so a result always belongs to the current state.
 */
export type Checking<T> =
  /** Nothing to check yet (no tool result, or the host can't read it). */
  | { status: 'idle' }
  /** Reading now and then, until the status is final. */
  | {
      status: 'following';
      data?: T;
      /** Consecutive failed reads. */
      failures: number;
      startedAt: number;
      /** How long to wait before the next read: none for a run's first. */
      delayMs: number;
    }
  /** The status is final: done, failed, or one that won't change by itself. */
  | { status: 'settled'; data: T }
  /** Checking gave up; Retry is offered. */
  | { status: 'stopped'; data?: T; reason: StopReason }
  /** Retry's read is in flight; the reason it replaces stays shown. */
  | { status: 'retrying'; data?: T; reason: StopReason };

/**
 * `read` and `readFailed` are the result of the read in flight: part of
 * following the status, or of Retry, depending on the state.
 */
export type CheckingEvent<T> =
  | { type: 'start'; at: number }
  /** `terminal`: the status read is final (see `isFinal`). */
  | { type: 'read'; data: T; terminal: boolean; at: number }
  | { type: 'readFailed'; message: string; at: number }
  | { type: 'retry' };

/**
 * Whether checking can stop at this progress: done, failed, or a status that
 * won't move on by itself (paused, say), so reading it again would only show
 * the same thing.
 */
const isFinal = (progress: Progress) =>
  progress.state === 'done' ||
  progress.state === 'failed' ||
  (progress.state === 'other' && !progress.isChanging);

/** The next tick would pass the timeout. */
const outOfTime = (startedAt: number, at: number) =>
  at - startedAt + POLL_INTERVAL_MS >= POLL_TIMEOUT_MS;

const dataOf = <T>(state: Checking<T>): T | undefined =>
  state.status === 'idle' ? undefined : state.data;

/**
 * The next state; an event that doesn't fit the current one (a result when
 * nothing is being read, say) returns `state` itself, so nothing changes.
 * Reading is not done here: `useCreationStatus` reads whenever the state is
 * following or retrying.
 */
export function checkingTransition<T>(
  state: Checking<T>,
  event: CheckingEvent<T>
): Checking<T> {
  switch (event.type) {
    case 'start':
      if (state.status !== 'idle') return state;
      return {
        status: 'following',
        failures: 0,
        startedAt: event.at,
        delayMs: 0,
      };
    case 'read':
      if (state.status === 'following') {
        if (event.terminal) return { status: 'settled', data: event.data };
        if (outOfTime(state.startedAt, event.at)) {
          return {
            status: 'stopped',
            data: event.data,
            reason: { type: 'timeout' },
          };
        }
        return {
          ...state,
          data: event.data,
          failures: 0,
          delayMs: POLL_INTERVAL_MS,
        };
      }
      if (state.status === 'retrying') {
        if (event.terminal) return { status: 'settled', data: event.data };
        // Like starting: the first read of the new run is immediate.
        return {
          status: 'following',
          data: event.data,
          failures: 0,
          startedAt: event.at,
          delayMs: 0,
        };
      }
      return state;
    case 'readFailed':
      if (state.status === 'following') {
        const failures = state.failures + 1;
        if (failures > POLL_MAX_RETRIES) {
          return {
            status: 'stopped',
            data: state.data,
            reason: { type: 'error', message: event.message },
          };
        }
        if (outOfTime(state.startedAt, event.at)) {
          return {
            status: 'stopped',
            data: state.data,
            reason: { type: 'timeout' },
          };
        }
        return { ...state, failures, delayMs: POLL_INTERVAL_MS };
      }
      if (state.status === 'retrying') {
        return {
          status: 'stopped',
          data: state.data,
          reason: { type: 'error', message: event.message },
        };
      }
      return state;
    case 'retry':
      if (state.status !== 'stopped') return state;
      return { ...state, status: 'retrying' };
  }
}

type Described = {
  badge?: ProjectCardBadge;
  note?: ProjectCardNote;
  /**
   * What screen readers hear when it changes; danger notes are announced
   * assertively on their own.
   */
  announcement: string;
};

/**
 * How the card shows a tool call and the checking of what it created: the
 * status badge, a note for a problem or for why the status won't update, and
 * what to announce. `data` is the latest read (see `useCreationStatus`).
 */
export function describeCreation<T extends { status: string }>({
  config: { noun, progress, checkWith },
  toolCall,
  checking,
  canRead,
}: {
  config: CreationConfig<T>;
  toolCall: ToolCallState<T>;
  checking: Checking<T>;
  /** Whether the view can read the status (see `useCreationStatus`'s `read`). */
  canRead: boolean;
}): Described {
  switch (toolCall.status) {
    // No tool result yet (the host may still be asking the user to confirm):
    // the card shows the call's arguments, if sent, and skeletons for the rest.
    case 'loading':
      return { announcement: `Loading ${noun}` };
    case 'error':
      return {
        badge: { label: 'Failed', tone: 'danger' },
        note: { tone: 'danger', text: toolCall.message },
        announcement: 'Failed',
      };
    case 'cancelled':
      return {
        badge: { label: 'Cancelled' },
        note: toolCall.reason
          ? { tone: 'muted', text: toolCall.reason }
          : undefined,
        announcement: 'Cancelled',
      };
    case 'ready':
      break;
  }

  const data = dataOf(checking) ?? toolCall.data;
  const current = progress(data.status);
  const stopReason =
    checking.status === 'stopped' || checking.status === 'retrying'
      ? checking.reason
      : undefined;
  const isFollowing = checking.status === 'following';

  if (stopReason?.type === 'error') {
    // A failed check replaces the status: the last one read may no longer be true.
    return {
      badge: {
        label: 'Check failed',
        tone: 'danger',
        title: `Failed to check status: ${stopReason.message}`,
      },
      note: {
        tone: 'danger',
        text: `Can't check status: ${stopReason.message}.`,
      },
      announcement: 'Check failed',
    };
  }

  let badge: ProjectCardBadge;
  let note: ProjectCardNote | undefined;
  let announcement: string;
  let isChanging = false;
  switch (current.state) {
    case 'done':
      badge = { label: 'Active', tone: 'success' };
      announcement = 'Active';
      break;
    case 'failed':
      badge = { label: 'Failed', tone: 'danger' };
      note = {
        tone: 'danger',
        text: `Failed while ${current.during.toLowerCase()} (${data.status}).`,
      };
      announcement = 'Failed';
      break;
    case 'step': {
      // Neutral, with the spinner saying it's in progress: hosts' warning
      // colours vary (Codex's is orange-red) and read as a problem.
      badge = { label: current.label, isSpinning: isFollowing };
      announcement = `${current.label}, step ${current.step} of ${current.of}`;
      isChanging = true;
      break;
    }
    case 'other':
      badge = {
        label: current.label,
        tone: current.tone,
        isSpinning: current.isChanging && isFollowing,
      };
      announcement = current.label;
      isChanging = current.isChanging;
      break;
  }

  if (!note) {
    if (stopReason?.type === 'timeout') {
      note = { tone: 'muted', text: 'Stopped checking after 10 minutes.' };
    } else if (!canRead && isChanging) {
      note = {
        tone: 'muted',
        text: `Status won't update here. Ask the assistant to check with ${checkWith}.`,
      };
    }
  }

  return { badge, note, announcement };
}

/**
 * Follows what a tool call created (a project, a branch) until it's ready,
 * and says how `ProjectCard` should show it: the status badge, a note for a
 * problem or for why the status won't update, and Retry once checking has
 * stopped without an answer. Changes are announced to screen readers.
 */
export function useCreationStatus<T extends { status: string }>({
  config,
  toolCall,
  read,
}: {
  config: CreationConfig<T>;
  toolCall: ToolCallState<T>;
  /**
   * Reads the latest version of what the tool call returned. Leave it out
   * when the status can't be read, e.g. the host can't proxy tool calls:
   * checking then never starts. It only matters until checking starts:
   * checking keeps going if `read` goes away, and its reads then fail.
   */
  read?: (created: T) => Promise<T>;
}) {
  const created = toolCall.status === 'ready' ? toolCall.data : undefined;

  const [checking, dispatch] = useReducer(checkingTransition<T>, {
    status: 'idle',
  });

  // Starts once there is a tool result to check and the host can read it.
  const canRead = !!read;
  useEffect(() => {
    if (canRead && created) dispatch({ type: 'start', at: Date.now() });
  }, [canRead, created]);

  // The latest read, without making `read`, `config` or `created` (which
  // change every render) dependencies of the effect below.
  const readLatest = useEffectEvent(async () => {
    if (!read) throw new Error("Can't read the status");
    const next = await read(created!);
    return { data: next, terminal: isFinal(config.progress(next.status)) };
  });

  // Reads whenever the state says to: after its delay when following, at once
  // for Retry. Each state change starts over, so a result from before it (or
  // after unmounting) is dropped.
  useEffect(() => {
    if (checking.status !== 'following' && checking.status !== 'retrying') {
      return;
    }
    let isLive = true;
    const timer = setTimeout(
      async () => {
        let event: CheckingEvent<T>;
        try {
          event = { type: 'read', ...(await readLatest()), at: Date.now() };
        } catch (error) {
          event = {
            type: 'readFailed',
            message: error instanceof Error ? error.message : String(error),
            at: Date.now(),
          };
        }
        if (isLive) dispatch(event);
      },
      checking.status === 'following' ? checking.delayMs : 0
    );
    return () => {
      isLive = false;
      clearTimeout(timer);
    };
  }, [checking]);

  const data = dataOf(checking) ?? created;
  const isRetrying = checking.status === 'retrying';

  const { badge, note, announcement } = describeCreation({
    config,
    toolCall,
    checking,
    canRead,
  });

  useAnnouncement(
    note?.tone === 'muted' ? `${announcement}. ${note.text}` : announcement
  );
  useAnnouncement(note?.tone === 'danger' ? note.text : undefined, 'assertive');

  // Checking stopped without an answer (the checks kept failing, or the
  // timeout passed) and can start again.
  const canRetry =
    toolCall.status === 'ready' &&
    canRead &&
    (checking.status === 'stopped' || isRetrying);

  const isLoading = toolCall.status === 'loading';

  return {
    /** The latest read, or what the tool call returned until there is one. */
    data,
    isLoading,
    isDone: !!data && config.progress(data.status).state === 'done',
    /** What the status gives `ProjectCard`: spread it in. */
    card: {
      isLoading,
      badge,
      note,
      onRetry: canRetry ? () => dispatch({ type: 'retry' }) : undefined,
      isRetrying,
    },
  };
}
