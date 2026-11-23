import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { useHostStyles as useSdkHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { useEffect } from 'react';

/** Mirrors the host's safe area (host chrome) into `--sb-inset-*` CSS variables. */
function applyInsets(context: McpUiHostContext | undefined) {
  const style = document.documentElement.style;
  const insets = context?.safeAreaInsets;
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    style.setProperty(`--sb-inset-${side}`, `${insets?.[side] ?? 0}px`);
  }
}

/**
 * Applies everything the host controls about how a view looks: the SDK's
 * theme (`data-theme`, `color-scheme`), style variables and fonts, which the
 * Supabase styles key on, plus the safe area insets, which the SDK hook
 * doesn't handle.
 */
export function useHostStyles(
  app: App | null,
  hostContext: McpUiHostContext | undefined
) {
  useSdkHostStyles(app, hostContext);
  useEffect(() => applyInsets(hostContext), [hostContext]);
}
