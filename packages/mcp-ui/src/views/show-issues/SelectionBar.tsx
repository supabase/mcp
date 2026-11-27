import '../../shared/button.css';
import { CheckIcon, SpinnerIcon, XCircleIcon } from '../../shared/icons';
import { HANDED_MESSAGE, type Handoff, type ReviewAction } from './handoff';

/** "Review selected (3)", or "Review selected" while nothing is. */
export const reviewLabel = (count: number) =>
  count === 0 ? 'Review selected' : `Review selected (${count})`;

/**
 * Clear, once something is selected, and the button that hands the selected
 * issues to the assistant, then the result of the last hand-off on a line of
 * its own. On a host that can't take messages from the view, a hint takes
 * the button's place on a line of its own, Clear at its end. Its parts are
 * laid out as the footer's own (see `view.css`). While the whole list
 * `loading` with nothing selected, the button is a placeholder of its size;
 * a selection kept across a refresh keeps the button.
 */
export function SelectionBar({
  count,
  action,
  loading,
  onClear,
}: {
  count: number;
  action: ReviewAction;
  /** The whole list is loading (`ListModel.loadingAll`). */
  loading: boolean;
  onClear: () => void;
}) {
  const clear = count > 0 && (
    <button
      type="button"
      data-size="sm"
      data-slot="clear"
      className="ghost"
      onClick={onClear}
    >
      Clear
    </button>
  );
  return (
    <div className="selection-bar">
      <div data-slot="actions" data-action={action.kind}>
        {action.kind === 'message' ? (
          <>
            {clear}
            {loading && !clear ? (
              <span data-slot="skeleton" aria-hidden="true" />
            ) : (
              <ReviewButton count={count} {...action} />
            )}
          </>
        ) : (
          <>
            <ReviewHint />
            {clear}
          </>
        )}
      </div>
      {action.kind === 'message' && (
        <HandoffResult handoff={action.handoff} count={count} />
      )}
    </div>
  );
}

/** "Review selected (N)", with a spinner while the hand-off is sent. */
function ReviewButton({
  count,
  handoff,
  review,
}: { count: number } & Extract<ReviewAction, { kind: 'message' }>) {
  const sending = handoff.status === 'sending';
  return (
    <button
      type="button"
      data-size="sm"
      data-slot="review"
      className="primary"
      disabled={count === 0 || sending}
      onClick={review}
    >
      {sending && <SpinnerIcon size={12} />}
      {reviewLabel(count)}
    </button>
  );
}

/**
 * In place of the Review button, on a host that can't take messages but
 * shows the assistant the selection.
 */
function ReviewHint() {
  return (
    <p data-slot="hint">
      The assistant can see the issues you select. Ask it about them in the
      chat.
    </p>
  );
}

/**
 * Why the last hand-off failed, or that it was handed (once nothing is
 * selected): one line each, the same but for the tone.
 */
function HandoffResult({
  handoff,
  count,
}: { handoff: Handoff; count: number }) {
  switch (handoff.status) {
    case 'failed':
      return (
        <p data-slot="handoff" data-tone="danger">
          <XCircleIcon slot="handoff-icon" size={12} />
          {handoff.message}
        </p>
      );
    case 'handed':
      if (count > 0) return null;
      return (
        <p data-slot="handoff" data-tone="success">
          <CheckIcon slot="handoff-icon" size={12} />
          {HANDED_MESSAGE}
        </p>
      );
    case 'idle':
    case 'sending':
      return null;
    default:
      return handoff satisfies never;
  }
}
