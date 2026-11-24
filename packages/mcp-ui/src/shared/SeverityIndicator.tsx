import './severity-indicator.css';

/** How severe an issue is, as Studio's issues page ranks it. */
export type Severity = 'info' | 'warning' | 'critical';

const FILLED_BAR_COUNT: Record<Severity, number> = {
  info: 1,
  warning: 2,
  critical: 3,
};

const BAR_HEIGHTS = [4, 7, 10];

/**
 * Three ascending bars, filled up to the issue's severity in its color, after
 * Studio's SeverityIndicator: one gray bar for info, two yellow for warning,
 * three red for critical.
 */
export function SeverityIndicator({
  severity,
  label,
}: {
  severity: Severity;
  /** What the bars mean, for screen readers. */
  label: string;
}) {
  const filledBarCount = FILLED_BAR_COUNT[severity];
  return (
    <svg
      viewBox="0 0 12 12"
      role="img"
      aria-label={label}
      className="severity-indicator"
      data-severity={severity}
    >
      {BAR_HEIGHTS.map((height, index) => (
        <rect
          key={height}
          x={1 + index * 4}
          y={11 - height}
          width={2}
          height={height}
          rx={0.5}
          data-filled={index < filledBarCount}
        />
      ))}
    </svg>
  );
}
