import './badge.css';
import type { ReactNode } from 'react';

/** A small pill label; `tone` colours it for success, warning or danger. */
export function Badge({
  tone,
  title,
  icon,
  children,
}: {
  tone?: 'success' | 'warning' | 'danger';
  /** Extra detail on hover, e.g. why a check failed. */
  title?: string;
  /** Shown before the label, e.g. a spinner. */
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="badge" data-tone={tone} title={title}>
      {icon}
      <span data-slot="label">{children}</span>
    </span>
  );
}
