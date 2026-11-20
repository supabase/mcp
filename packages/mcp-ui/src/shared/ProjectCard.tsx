import './project-card.css';
import { Fragment, type ReactNode } from 'react';
import { Badge, type Tone } from './Badge';
import {
  ExternalLinkIcon,
  RefreshIcon,
  SpinnerIcon,
  XCircleIcon,
} from './icons';

export type ProjectCardBadge = {
  label: string;
  tone?: Tone;
  /** Shows a spinner while the view follows a status that is changing. */
  isSpinning?: boolean;
  /** Extra detail on hover. */
  title?: string;
};

/** A line under the details: a problem, or why the status won't update. */
export type ProjectCardNote = { tone: 'danger' | 'muted'; text: string };

/** The section is labelled by the project name. */
const NAME_ID = 'project-card-name';

/**
 * The name for the card: the created one, else the one asked for in the
 * tool call's arguments. A call that failed or was cancelled before the host
 * sent its arguments has nothing more coming, so it gets a generic name
 * instead of a skeleton.
 */
export function cardName({
  created,
  requested,
  isLoading,
  noun,
}: {
  created?: string;
  requested?: string;
  isLoading: boolean;
  /** What is being created: "project" or "branch". */
  noun: string;
}) {
  return created ?? requested ?? (isLoading ? undefined : `New ${noun}`);
}

/** Stands in for data the card doesn't have yet, in the same place and size. */
function Skeleton({
  shape = 'text',
  width,
}: {
  shape?: 'text' | 'pill' | 'square';
  width?: 'short' | 'long';
}) {
  return (
    <span
      data-slot="skeleton"
      data-shape={shape}
      data-width={width}
      aria-hidden="true"
    />
  );
}

/**
 * One project (or branch, which is a project too) and its current status,
 * matching the project card in the Supabase surfaces: breadcrumbs, name and
 * status badge, then a dot-separated row of details (ref, region), with Open
 * in dashboard beside them. A note and `children` render below, e.g. a
 * problem or connection details.
 *
 * While `isLoading`, the layout stays the same and anything not known yet
 * (breadcrumbs, name, badge, a detail's value, the actions) is a skeleton.
 */
export function ProjectCard({
  isLoading = false,
  breadcrumbs = [],
  name,
  badge,
  note,
  details,
  onRetry,
  isRetrying = false,
  onOpenDashboard,
  children,
}: {
  isLoading?: boolean;
  /**
   * Names of what it belongs to, outermost first, shown above the name once
   * known: the organization, then for a branch its project. Slugs are not
   * shown: they rarely read as names.
   */
  breadcrumbs?: string[];
  name?: string;
  badge?: ProjectCardBadge;
  note?: ProjectCardNote;
  /** Labels are for screen readers; the values are shown, or skeletons while loading. */
  details: { label: string; value?: string }[];
  /**
   * Checks the status again, from a small icon beside the badge. Pass it only
   * when checking has stopped without an answer.
   */
  onRetry?: () => void;
  isRetrying?: boolean;
  /** Opens the project in the Supabase dashboard. Omit to hide the action. */
  onOpenDashboard?: () => void;
  children?: ReactNode;
}) {
  return (
    <section
      className="project-card"
      aria-labelledby={NAME_ID}
      aria-busy={isLoading || isRetrying}
    >
      <div data-slot="header">
        <div data-slot="project-info">
          {(breadcrumbs.length > 0 || isLoading) && (
            <p data-slot="breadcrumbs">
              {breadcrumbs.length > 0 ? (
                breadcrumbs.map((crumb, index) => (
                  <Fragment key={index}>
                    {index > 0 && (
                      <span data-slot="crumb-separator" aria-hidden="true">
                        /
                      </span>
                    )}
                    {crumb}
                  </Fragment>
                ))
              ) : (
                <Skeleton width="short" />
              )}
            </p>
          )}
          <div data-slot="title-row">
            <h2 data-slot="name" id={NAME_ID}>
              {name ?? <Skeleton width="long" />}
            </h2>
            {badge ? (
              <Badge
                tone={badge.tone}
                title={badge.title}
                icon={badge.isSpinning ? <SpinnerIcon size={10} /> : undefined}
              >
                {badge.label}
              </Badge>
            ) : (
              <Skeleton shape="pill" />
            )}
            {onRetry && (
              <button
                type="button"
                data-slot="retry"
                aria-label="Retry"
                title="Check the status again"
                disabled={isRetrying}
                onClick={onRetry}
              >
                {isRetrying ? (
                  <SpinnerIcon size={12} />
                ) : (
                  <RefreshIcon size={12} />
                )}
              </button>
            )}
          </div>
          {details.length > 0 && (
            <dl data-slot="details">
              {details.map((detail) => (
                <div data-slot="detail" key={detail.label}>
                  {/* Every detail has one; the separator starting each line is clipped (see the CSS). */}
                  <span data-slot="detail-separator" aria-hidden="true">
                    ·
                  </span>
                  <dt className="sr-only">{detail.label}</dt>
                  <dd data-slot="detail-value">
                    {detail.value ?? <Skeleton />}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        {(isLoading || onOpenDashboard) && (
          <div data-slot="actions">
            {isLoading ? (
              <Skeleton shape="square" />
            ) : (
              <button
                type="button"
                data-slot="action-icon-button"
                aria-label="Open in dashboard"
                title="Open in dashboard"
                onClick={onOpenDashboard}
              >
                <ExternalLinkIcon />
              </button>
            )}
          </div>
        )}
      </div>
      {note && (
        <div data-slot="note" data-tone={note.tone}>
          {note.tone === 'danger' && <XCircleIcon />}
          <p data-slot="note-text">{note.text}</p>
        </div>
      )}
      {children}
    </section>
  );
}
