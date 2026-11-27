/**
 * Handing the selected issues to the assistant with one message: how the
 * last one went, and how this host offers it. The view machine
 * (`view-state.ts`) moves between these states.
 */

export type Handoff =
  | { status: 'idle' }
  | { status: 'sending' }
  /**
   * The host took the message. It may still ask the user before sending it,
   * so this means "handed to chat", not "sent".
   */
  | { status: 'handed' }
  | { status: 'failed'; message: string };

/** How the user hands the selected issues to the assistant on this host. */
export type ReviewAction =
  /**
   * The host takes messages from the view: Review sends one. `handoff` is
   * how the last one went.
   */
  | { kind: 'message'; handoff: Handoff; review: () => void }
  /**
   * It doesn't, but it shows the assistant the selection
   * (`updateModelContext`): a hint says to ask about it in the chat.
   */
  | { kind: 'hint' };

export const initialHandoff: Handoff = { status: 'idle' };

/** What the view shows and announces once the host takes the message. */
export const HANDED_MESSAGE = 'Handed to chat';
