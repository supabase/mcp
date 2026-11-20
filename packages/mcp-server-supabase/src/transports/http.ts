import { createMcpHandler } from '@modelcontextprotocol/server';

import {
  createSupabaseMcpServer,
  type SupabaseMcpServerOptions,
} from '../server.js';

export type SupabaseMcpHandlerOptions = {
  /** Receives SDK-reported transport and request errors without changing responses. */
  onerror?: (error: Error) => void;
};

// Modern protocol only: created with `legacy: 'reject'`, so a client that
// speaks just the 2025-era protocol gets an HTTP 400 instead of being served.
export function createSupabaseMcpHandler(
  options: SupabaseMcpServerOptions,
  handlerOptions: SupabaseMcpHandlerOptions = {}
) {
  return createMcpHandler(() => createSupabaseMcpServer(options), {
    legacy: 'reject',
    ...handlerOptions,
  });
}
