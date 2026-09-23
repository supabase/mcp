import {
  createSupabaseMcpHandler,
  CURRENT_ELICITATION_TOOLS,
  type ElicitationToolName,
  type SupabaseMcpServerOptions,
} from '@supabase/mcp-server-supabase';
import {
  createMcpServer,
  tool,
  type McpServerOptions,
  type Tool,
} from '@supabase/mcp-utils';
import type * as Utils from '@supabase/mcp-utils';
import { z } from 'zod/v4';

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
};

const handler = createSupabaseMcpHandler(options);

// Touch every member of the public McpHttpHandler shape so a signature
// change here fails the typecheck, not just a missing export.
void handler.fetch;
void handler.close;
void handler.notify;
void handler.bus;

// The unified `elicitation` option, and the `ElicitationToolName`/
// `CURRENT_ELICITATION_TOOLS` catalog it's typed against, are part of the
// packed public declaration surface: a shape drift here must fail this
// typecheck rather than surface only in an internal test.
const enabledTools: readonly ElicitationToolName[] = CURRENT_ELICITATION_TOOLS;

const optionsWithElicitation: SupabaseMcpServerOptions = {
  platform: { account },
  features: ['account'],
  elicitation: {
    requestState: {
      key: 'a'.repeat(32),
      principal: 'packed-consumer-fixture',
      ttlSeconds: 120,
    },
    confirmation: { enabledTools },
    secretCollection: {
      connectUrlTemplate:
        'https://example.com/dashboard/mcp/secrets?ref={ref}&name={name}',
    },
  },
};

const handlerWithElicitation = createSupabaseMcpHandler(optionsWithElicitation);
void handlerWithElicitation.fetch;

// Check published exports and their relationships, not a copy of the vocabulary.
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
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;
type Assert<T extends true> = T;
type ExactUtilsOption = Assert<
  Equal<McpServerOptions['observer'], Utils.RequestObserver | undefined>
>;
type ExactRecorder = Assert<
  Equal<
    Parameters<Tool['execute']>[2],
    ((fact: Utils.ObservationFact) => void) | undefined
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
