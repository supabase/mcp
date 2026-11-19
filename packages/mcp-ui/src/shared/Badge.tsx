import type { ReactNode } from 'react';

/** A small pill label; `tone` colours it for success, warning or danger. */
export function Badge({
  tone,
  children,
}: {
  tone?: 'success' | 'warning' | 'danger';
  children: ReactNode;
}) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}
