import { Server, type ServerContext } from '@modelcontextprotocol/server';
import { vi } from 'vitest';
import { z } from 'zod/v4';
import type {
  ObservationContext,
  ObservationEnd,
  RequestObserver,
} from './observation.js';
import {
  createMcpServer,
  type McpServerOptions,
  type Tool,
  tool,
} from './server.js';

export type TestFact = { event: string };
export type TestTool = Tool<z.ZodObject<any>, z.ZodObject<any>, TestFact>;

export function capture<Bucket extends string = never, Fact = TestFact>() {
  const scopes: {
    context: ObservationContext<Bucket>;
    facts: Fact[];
    ends: ObservationEnd[];
  }[] = [];
  const observer: RequestObserver<Bucket, Fact> = (context) => {
    const scope = {
      context,
      facts: [] as Fact[],
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
export function handlers<Bucket extends string = never, Fact = TestFact>(
  options: Partial<McpServerOptions<Bucket, Fact>> = {}
) {
  const registration = vi.spyOn(Server.prototype, 'setRequestHandler');
  createMcpServer<Bucket, Fact>({ name: 'test', version: '1', ...options });
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

export function action<Fact = TestFact>(
  execute: Tool<z.ZodObject<any>, z.ZodObject<any>, Fact>['execute']
) {
  return tool<z.ZodObject<any>, z.ZodObject<any>, Fact>({
    description: 'test',
    parameters: z.object({}),
    outputSchema: z.looseObject({}),
    execute,
  });
}
