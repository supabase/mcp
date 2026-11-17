import type { ReactNode } from 'react';

/** A single line of status text: loading, empty or error. */
export function Message({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: 'error';
}) {
  return (
    <p
      className={tone === 'error' ? 'text-destructive' : 'text-lighter'}
      style={{ margin: 0, padding: '8px 0' }}
    >
      {children}
    </p>
  );
}
