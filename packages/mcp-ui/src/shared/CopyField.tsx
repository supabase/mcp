import { useEffect, useRef, useState } from 'react';
import { useAnnounce } from './Announcer';
import { CheckIcon, CopyIcon, XCircleIcon } from './icons';

const FEEDBACK_MS = 1500;

/**
 * Label, monospace value and a copy button. The button's name stays "Copy
 * {label}"; the result is announced instead, since screen readers don't
 * reliably announce a name change on a focused button.
 */
export function CopyField({ label, value }: { label: string; value: string }) {
  const announce = useAnnounce();
  const [state, setState] = useState<'copied' | 'failed' | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function flash(next: 'copied' | 'failed') {
    clearTimeout(timer.current);
    setState(next);
    timer.current = setTimeout(() => setState(undefined), FEEDBACK_MS);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      flash('copied');
      announce(`Copied ${label}`);
    } catch {
      // Hosts without the clipboard permission reject; the value stays
      // selectable in the field.
      flash('failed');
      announce(`Couldn't copy ${label}`, 'assertive');
    }
  }

  return (
    <div className="copy-field">
      <span data-slot="label">{label}</span>
      <div data-slot="control">
        <code data-slot="value">{value}</code>
        <button
          type="button"
          data-slot="copy"
          data-state={state}
          onClick={copy}
        >
          {state === 'copied' ? (
            <CheckIcon />
          ) : state === 'failed' ? (
            <XCircleIcon />
          ) : (
            <CopyIcon />
          )}
          <span className="sr-only">Copy {label}</span>
        </button>
      </div>
    </div>
  );
}
