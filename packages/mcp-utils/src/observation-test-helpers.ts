import { Server, type ServerContext } from '@modelcontextprotocol/server';
import { vi } from 'vitest';
import { z } from 'zod/v4';
import type {
  ObservationContext,
  ObservationEnd,
  ObservationFact,
  RequestObserver,
} from './observation.js';
import {
  createMcpServer,
  type McpServerOptions,
  type Tool,
  tool,
} from './server.js';

export function capture() {
  const scopes: {
    context: ObservationContext;
    facts: ObservationFact[];
    ends: ObservationEnd[];
  }[] = [];
  const observer: RequestObserver = (context) => {
    const scope = {
      context,
      facts: [] as ObservationFact[],
      ends: [] as ObservationEnd[],
    };
    scopes.push(scope);
    return {
      record(fact) {
        scope.facts.push(fact);
      },
      end(end) {
        scope.ends.push(end);
      },
    };
  };
  return { observer, scopes };
}

// Exercise the registered package handler, before the SDK's result validator.
// This is needed for deliberately unserializable returns and error serialization.
export function handlers(options: Partial<McpServerOptions> = {}) {
  const registration = vi.spyOn(Server.prototype, 'setRequestHandler');
  createMcpServer({ name: 'test', version: '1', ...options });
  // The package uses only the two-argument registration overload.
  type Handler = (
    request: unknown,
    ctx: ServerContext
  ) => unknown | Promise<unknown>;
  const calls = registration.mock.calls as unknown as [string, Handler][];
  const registered = Object.fromEntries(calls);
  registration.mockRestore();
  return async (method: string, params: Record<string, unknown> = {}) => {
    const handler = registered[method];
    if (!handler) throw new Error(`Handler not registered: ${method}`);
    // Each request below supplies the params for its method; SDK validation is
    // tested separately through the real transport in server-observation-sdk.test.ts.
    return handler({ method, params }, {} as ServerContext);
  };
}

export function action(execute: Tool['execute']) {
  return tool({
    description: 'test',
    parameters: z.object({}),
    outputSchema: z.looseObject({}),
    execute,
  });
}
