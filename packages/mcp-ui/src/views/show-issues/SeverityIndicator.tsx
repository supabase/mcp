import type { IssueSummary } from './issues-schema';

/**
 * Studio's severity bars: three red for critical, two yellow (of three) for
 * a warning. Decorative: the row's text names the severity too.
 */
export function SeverityIndicator({
  severity,
}: {
  severity: IssueSummary['severity'];
}) {
  const lit = severity === 'critical' ? 3 : 2;
  return (
    <span
      className="severity-indicator"
      data-severity={severity}
      aria-hidden="true"
    >
      {[1, 2, 3].map((bar) => (
        <span key={bar} data-slot="bar" data-lit={bar <= lit} />
      ))}
    </span>
  );
}
