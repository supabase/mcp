import './admonition.css';

import type { ReactNode } from 'react';

import { WarningGlyph } from './icons';

/**
 * A boxed message with an icon, title and description, after the Admonition
 * in the Supabase surfaces (ui-patterns): `warning` for a failed read, such
 * as a query that didn't run, `destructive` for a failed action.
 */
export function Admonition({
  type,
  layout,
  title,
  description,
  actions,
}: {
  type: 'warning' | 'destructive';
  /**
   * `full-bleed` spans its container edge to edge, with no side borders or
   * radius: the Sandwiched Admonition, for callouts between other content.
   */
  layout?: 'full-bleed';
  title: string;
  description?: ReactNode;
  /** Buttons below the description, e.g. Retry. */
  actions?: ReactNode;
}) {
  return (
    <div
      className="admonition"
      data-tone={type === 'warning' ? 'warning' : 'danger'}
      data-layout={layout}
      role="alert"
      aria-label={type === 'warning' ? 'Warning' : 'Danger'}
    >
      <span data-slot="icon">
        <WarningGlyph />
      </span>
      <div data-slot="body">
        <p data-slot="title">{title}</p>
        {description && <div data-slot="description">{description}</div>}
        {actions && <div data-slot="actions">{actions}</div>}
      </div>
    </div>
  );
}
