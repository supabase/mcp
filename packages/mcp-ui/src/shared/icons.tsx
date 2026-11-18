/** Inline SVG icons (no icon dependency, to keep the HTML small). */
const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  className: 'icon',
} as const;

export function SpinnerIcon() {
  return (
    <svg {...base} data-state="spinning">
      <circle cx="8" cy="8" r="6" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" />
    </svg>
  );
}

export function XCircleIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="6" />
      <path d="m6 6 4 4m0-4-4 4" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg {...base}>
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg {...base}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg {...base}>
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

export function ActivityIcon() {
  return (
    <svg {...base}>
      <path d="M1.5 8h2.5l2-5 4 10 2-5h2.5" />
    </svg>
  );
}

export function ExternalLinkIcon() {
  return (
    <svg {...base}>
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
    </svg>
  );
}
