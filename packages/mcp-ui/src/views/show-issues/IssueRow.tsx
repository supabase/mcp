import { useId } from 'react';
import type { IssueSummary } from './issues-schema';
import { SeverityIndicator } from './SeverityIndicator';

const CATEGORY_LABELS: Record<IssueSummary['category'], string> = {
  security: 'Security',
  performance: 'Performance',
  health: 'Health',
};

const SEVERITY_LABELS: Record<IssueSummary['severity'], string> = {
  critical: 'Error',
  warning: 'Warning',
};

/** "Security · Error · 3 findings", the line under an issue's title. */
export function issueMeta(issue: IssueSummary) {
  const findings = `${issue.affected_count} ${issue.affected_count === 1 ? 'finding' : 'findings'}`;
  return [
    CATEGORY_LABELS[issue.category],
    SEVERITY_LABELS[issue.severity],
    findings,
  ].join(' · ');
}

/**
 * One issue: the severity bars, the title on one line and its category,
 * severity and findings under it. Where issues can be selected, a checkbox
 * labelled by the title comes first, and the whole row toggles it.
 */
export function IssueRow({
  issue,
  checkbox,
}: {
  issue: IssueSummary;
  checkbox?: { checked: boolean; onToggle: (issue: IssueSummary) => void };
}) {
  const id = useId();
  const body = (
    <>
      <SeverityIndicator severity={issue.severity} />
      <span data-slot="text">
        <span data-slot="title" id={`${id}-title`} title={issue.title}>
          {issue.title}
        </span>
        <span data-slot="meta" id={`${id}-meta`}>
          {issueMeta(issue)}
        </span>
      </span>
    </>
  );
  return (
    <li className="issue-row">
      {checkbox ? (
        <label data-slot="target">
          <input
            type="checkbox"
            data-slot="checkbox"
            checked={checkbox.checked}
            aria-labelledby={`${id}-title`}
            aria-describedby={`${id}-meta`}
            onChange={() => checkbox.onToggle(issue)}
          />
          {body}
        </label>
      ) : (
        <div data-slot="body">{body}</div>
      )}
    </li>
  );
}
