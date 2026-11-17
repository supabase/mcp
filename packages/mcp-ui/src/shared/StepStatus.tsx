import { Badge } from './Badge';
import { SpinnerIcon, XCircleIcon } from './icons';

export type StepState = 'pending' | 'active' | 'done' | 'failed';

export type Step = { label: string; state: StepState };

/**
 * Derives step states from the index of the current step: earlier steps are
 * done, `current` is active (or failed), later ones stay pending. A `current`
 * past the end means every step is done.
 */
export function stepsAt(
  labels: string[],
  current: number,
  failed = false
): Step[] {
  return labels.map((label, i) => ({
    label,
    state:
      i < current
        ? 'done'
        : i === current
          ? failed
            ? 'failed'
            : 'active'
          : 'pending',
  }));
}

/** The first step that isn't done (running or failed), and its index. */
function current(steps: Step[]) {
  const index = steps.findIndex((step) => step.state !== 'done');
  return index === -1 ? undefined : { index, step: steps[index]! };
}

/**
 * Top-right of the card: "Step X of Y" while running, then a "Ready" or
 * "Failed" pill, or a "Timed out" pill if polling gave up first.
 */
export function StepBadge({
  steps,
  timedOut = false,
  readyLabel = 'Ready',
}: {
  steps: Step[];
  timedOut?: boolean;
  readyLabel?: string;
}) {
  const now = current(steps);
  if (!now) {
    return <Badge tone="success">{readyLabel}</Badge>;
  }
  if (now.step.state === 'failed') {
    return <Badge tone="danger">Failed</Badge>;
  }
  if (timedOut) {
    return <Badge tone="warning">Timed out</Badge>;
  }
  return (
    <Badge>
      Step {now.index + 1} of {steps.length}
    </Badge>
  );
}

/**
 * The running step with a spinner, or the step that failed. Nothing once
 * every step is done. `running` false (polling stopped) drops the spinner.
 * Visual only: announce changes with `stepAnnouncement` and `useAnnouncement`.
 */
export function StepLine({
  steps,
  running = true,
}: {
  steps: Step[];
  running?: boolean;
}) {
  const now = current(steps);
  if (!now) return null;
  if (now.step.state === 'failed') {
    return (
      <div data-slot="step" data-state={now.step.state}>
        <XCircleIcon />
        <span>{now.step.label} failed</span>
      </div>
    );
  }
  return (
    <div data-slot="step" data-state={now.step.state}>
      {running && <SpinnerIcon />}
      <span>{now.step.label}…</span>
    </div>
  );
}

/** What a screen reader should hear for the current steps. */
export function stepAnnouncement(
  steps: Step[],
  readyLabel = 'Ready'
): { polite?: string; assertive?: string } {
  const now = current(steps);
  if (!now) return { polite: readyLabel };
  if (now.step.state === 'failed') {
    return { assertive: `${now.step.label} failed` };
  }
  return {
    polite: `${now.step.label}, step ${now.index + 1} of ${steps.length}`,
  };
}
