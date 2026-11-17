import { useEffect, useRef, useState } from 'react';
import { CopyIcon } from './icons';

/** Label, monospace value and a copy button with "Copied" feedback. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>(
    'idle'
  );
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback('copied');
    } catch {
      // Hosts without the clipboard permission reject; the value stays
      // selectable in the field.
      setFeedback('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback('idle'), 2000);
  }

  return (
    <div className="copy-field">
      <span className="heading-meta">{label}</span>
      <div className="copy-value">
        <code className="mono">{value}</code>
        <button
          type="button"
          className="btn row"
          onClick={copy}
          aria-label={`Copy ${label}`}
        >
          <CopyIcon />
          {feedback === 'copied'
            ? 'Copied'
            : feedback === 'failed'
              ? 'Copy failed'
              : 'Copy'}
        </button>
      </div>
    </div>
  );
}
