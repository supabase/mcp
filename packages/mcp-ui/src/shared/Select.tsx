import './select.css';

import { ChevronDownIcon } from './icons';

/**
 * A native select drawn as Studio's Select trigger, with its chevron: `sm`
 * (the default) at the shared control height, `tiny` for toolbars. Native, so
 * its list is the platform's and it needs no popover.
 */
export function Select({
  id,
  label,
  value,
  options,
  disabled = false,
  size = 'sm',
  slot,
  onChange,
}: {
  id?: string;
  /** The accessible name, when no `<label>` points at `id`. */
  label?: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  size?: 'sm' | 'tiny';
  /** Names the select as a part of the component it sits in. */
  slot?: string;
  onChange: (value: string) => void;
}) {
  return (
    <span className="select" data-size={size} data-slot={slot}>
      <select
        id={id}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {!options.some((option) => option.value === value) && (
          <option value={value} disabled>
            {value === '' ? 'Choose a value' : value}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon slot="chevron" size={size === 'tiny' ? 14 : 16} />
    </span>
  );
}
