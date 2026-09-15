import {
  createSupabaseMcpHandler,
  createSupabaseMcpServer,
  type SupabaseMcpServerOptions,
} from '@supabase/mcp-server-supabase';

import {
  createMcpServer,
  tool,
  type McpServerOptions,
  type Tool,
} from '@supabase/mcp-utils';
import type * as Utils from '@supabase/mcp-utils';
import type * as Supabase from '@supabase/mcp-server-supabase';
import { z } from 'zod/v4';

type ExpectedMethod =
  | 'tools/call'
  | 'tools/list'
  | 'resources/list'
  | 'resources/templates/list'
  | 'resources/read';
type ExpectedTool =
  | 'create_project'
  | 'create_branch'
  | 'execute_sql'
  | 'apply_migration'
  | 'other'
  | 'not_applicable';
type ExpectedContext = Readonly<{ method: ExpectedMethod; tool: ExpectedTool }>;
type ExpectedFact =
  | Readonly<{
      kind: 'confirmation_decision';
      feature: 'cost';
      route: 'inline' | 'legacy' | 'bypass' | 'blocked';
      reason:
        | 'eligible'
        | 'not_configured'
        | 'capability_missing'
        | 'read_only'
        | 'zero_cost';
    }>
  | Readonly<{
      kind: 'input_required';
      feature: 'cost';
      mode: 'form';
      reason: 'initial' | 'missing_response' | 'changed_quote';
    }>
  | Readonly<{
      kind: 'input_response';
      feature: 'cost';
      action: 'accept' | 'decline' | 'cancel';
    }>
  | Readonly<{
      kind: 'resume_validation';
      feature: 'cost';
      result:
        | 'valid'
        | 'missing_response'
        | 'tool_mismatch'
        | 'arguments_mismatch'
        | 'changed_quote';
    }>
  | Readonly<{ kind: 'operation'; feature: 'cost'; disposition: 'started' }>
  | Readonly<{
      kind: 'operation';
      feature: 'cost';
      disposition: 'returned' | 'threw';
      durationMs: number;
    }>;
type ExpectedEnd = Readonly<{
  result:
    | 'completed'
    | 'input_required'
    | 'declined'
    | 'cancelled'
    | 'tool_error'
    | 'handler_error';
  durationMs: number;
}>;
type ExpectedObservation = Readonly<{
  record(fact: ExpectedFact): void | Promise<void>;
  end(result: ExpectedEnd): void | Promise<void>;
}>;
type ExpectedObserver = (
  context: ExpectedContext
) => ExpectedObservation | undefined;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;
type Assert<T extends true> = T;
type ExpectedContract = [
  ExpectedMethod,
  ExpectedTool,
  ExpectedContext,
  'cost',
  ExpectedFact,
  ExpectedEnd,
  ExpectedObservation,
  ExpectedObserver,
];
type UtilsContract = [
  Utils.ObservedMethod,
  Utils.ObservedTool,
  Utils.ObservationContext,
  Utils.ConfirmationFeature,
  Utils.ObservationFact,
  Utils.ObservationEnd,
  Utils.RequestObservation,
  Utils.RequestObserver,
];
type SupabaseContract = [
  Supabase.ObservedMethod,
  Supabase.ObservedTool,
  Supabase.ObservationContext,
  Supabase.ConfirmationFeature,
  Supabase.ObservationFact,
  Supabase.ObservationEnd,
  Supabase.RequestObservation,
  Supabase.RequestObserver,
];
type ExactUtilsContract = Assert<Equal<UtilsContract, ExpectedContract>>;
type ExactSupabaseContract = Assert<Equal<SupabaseContract, ExpectedContract>>;
type ExactUtilsOption = Assert<
  Equal<McpServerOptions['observer'], ExpectedObserver | undefined>
>;
type ExactSupabaseOption = Assert<
  Equal<SupabaseMcpServerOptions['observer'], ExpectedObserver | undefined>
>;
type ExactRecorder = Assert<
  Equal<
    Parameters<Tool['execute']>[2],
    ((fact: ExpectedFact) => void) | undefined
  >
>;

const observer: Utils.RequestObserver = (context) => ({
  record: async (fact) => {
    void context.method;
    void fact.kind;
  },
  end: (result) => {
    void result.durationMs;
  },
});
const observedTool = tool({
  description: 'Public third-argument compatibility',
  parameters: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (_params, _context, record) => {
    record?.({ kind: 'operation', feature: 'cost', disposition: 'started' });
    return { ok: true };
  },
});
// Existing one-/two-argument implementations remain assignable.
const oneArgument: typeof observedTool.execute = async (_params) => ({
  ok: true,
});
const twoArguments: typeof observedTool.execute = async (
  _params,
  _context
) => ({ ok: true });
void oneArgument;
void twoArguments;
const coreOptions: McpServerOptions = {
  name: 'packed-observer',
  version: '0.0.0',
  observer,
  tools: { observed: observedTool },
};
void createMcpServer(coreOptions);
// A stubbed `account` platform, whose seven operations only ever run on a
// tool call and so can reject here. It buys the thing that matters: asking
// for the `account` feature group makes the server register real tools, so
// the typecheck covers the zod-backed tool surface rather than an empty one.
const account: SupabaseMcpServerOptions['platform']['account'] = {
  listOrganizations: () => Promise.reject(new Error('not implemented')),
  getOrganization: () => Promise.reject(new Error('not implemented')),
  listProjects: () => Promise.reject(new Error('not implemented')),
  getProject: () => Promise.reject(new Error('not implemented')),
  createProject: () => Promise.reject(new Error('not implemented')),
  pauseProject: () => Promise.reject(new Error('not implemented')),
  restoreProject: () => Promise.reject(new Error('not implemented')),
};

const options: SupabaseMcpServerOptions = {
  platform: { account },
  features: ['account'],
  observer,
};
void createSupabaseMcpServer(options);

const handler = createSupabaseMcpHandler(options);

// Touch every member of the public McpHttpHandler shape so a signature
// change here fails the typecheck, not just a missing export.
void handler.fetch;
void handler.close;
void handler.notify;
void handler.bus;
