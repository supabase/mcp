import type { ReactNode } from 'react';

/** Inline SVG icons (no icon dependency, to keep the HTML small). */
export type IconProps = {
  /**
   * Marks the icon as a part of the component it sits in, so that component
   * can style it with `data-slot` instead of the `.icon` class.
   */
  slot?: string;
  /** Width and height in px; shrinks an icon to sit inside small text. */
  size?: number;
};

function Icon({
  slot,
  size = 16,
  state,
  children,
}: IconProps & { state?: string; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="icon"
      data-slot={slot}
      data-state={state}
    >
      {children}
    </svg>
  );
}

export function SpinnerIcon(props: IconProps) {
  return (
    <Icon {...props} state="spinning">
      <circle cx="8" cy="8" r="6" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.5 3v3h-3" />
      <path d="M13.2 6A5.5 5.5 0 1 0 13 10.5" />
    </Icon>
  );
}

export function XCircleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="m6 6 4 4m0-4-4 4" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3.5 8.5 3 3 6-7" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </Icon>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4 6 4 4 4-4" />
    </Icon>
  );
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
    </Icon>
  );
}

/*
 * Lucide icons, drawn from Lucide's own paths on its 24px grid, for parts the
 * Supabase surfaces draw with lucide-react (stroke 2, the surfaces' default),
 * so they match the surfaces exactly.
 */
function LucideIcon({
  slot,
  size = 16,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="icon"
      data-slot={slot}
    >
      {children}
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <LucideIcon {...props}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </LucideIcon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <LucideIcon {...props}>
      <path d="m6 9 6 6 6-6" />
    </LucideIcon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <LucideIcon {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </LucideIcon>
  );
}

export function XIcon(props: IconProps) {
  return (
    <LucideIcon {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </LucideIcon>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <LucideIcon {...props}>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </LucideIcon>
  );
}

export function KeyRoundIcon(props: IconProps) {
  return (
    <LucideIcon {...props}>
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </LucideIcon>
  );
}

export function LockKeyholeIcon(props: IconProps) {
  return (
    <LucideIcon {...props}>
      <circle cx="12" cy="16" r="1" />
      <rect x="3" y="10" width="18" height="12" rx="2" />
      <path d="M7 10V7a5 5 0 0 1 10 0v3" />
    </LucideIcon>
  );
}

export function RefreshCwIcon(props: IconProps) {
  return (
    <LucideIcon {...props}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </LucideIcon>
  );
}

export function CodeSquareIcon(props: IconProps) {
  return (
    <LucideIcon {...props}>
      <path d="m10 9-3 3 3 3" />
      <path d="m14 15 3-3-3-3" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </LucideIcon>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <LucideIcon {...props}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </LucideIcon>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <LucideIcon {...props}>
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </LucideIcon>
  );
}

/** The warning glyph of the Supabase Admonition (filled, on its own grid). */
export function WarningGlyph() {
  return (
    <svg viewBox="0 0 22 20" fill="currentColor" aria-hidden className="icon">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.15137 1.95117C9.30615 -0.0488281 12.1943 -0.0488281 13.3481 1.95117L20.7031 14.6992C21.8574 16.6992 20.4131 19.1992 18.104 19.1992H3.39502C1.08594 19.1992 -0.356933 16.6992 0.797364 14.6992L8.15137 1.95117ZM11.7666 16.0083C11.4971 16.2778 11.1313 16.4292 10.75 16.4292C10.3687 16.4292 10.0029 16.2778 9.7334 16.0083C9.46387 15.7388 9.3125 15.373 9.3125 14.9917C9.3125 14.9307 9.31641 14.8706 9.32373 14.811C9.33545 14.7197 9.35547 14.6304 9.38379 14.5439L9.41406 14.4609C9.48584 14.2803 9.59375 14.1147 9.7334 13.9751C10.0029 13.7056 10.3687 13.5542 10.75 13.5542C11.1313 13.5542 11.4971 13.7056 11.7666 13.9751C12.0361 14.2446 12.1875 14.6104 12.1875 14.9917C12.1875 15.373 12.0361 15.7388 11.7666 16.0083ZM10.75 4.69971C11.0317 4.69971 11.3022 4.81152 11.5015 5.01074C11.7007 5.20996 11.8125 5.48047 11.8125 5.76221V11.0747C11.8125 11.3564 11.7007 11.627 11.5015 11.8262C11.3022 12.0254 11.0317 12.1372 10.75 12.1372C10.4683 12.1372 10.1978 12.0254 9.99854 11.8262C9.79932 11.627 9.6875 11.3564 9.6875 11.0747V5.76221C9.6875 5.48047 9.79932 5.20996 9.99854 5.01074C10.1978 4.81152 10.4683 4.69971 10.75 4.69971Z"
      />
    </svg>
  );
}
