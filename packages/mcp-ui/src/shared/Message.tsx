import './message.css';
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
    <p className="message" data-tone={tone}>
      {children}
    </p>
  );
}
