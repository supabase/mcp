import {
  createSupabaseMcpHandler,
  createSupabaseMcpServer,
  CURRENT_ELICITATION_TOOLS,
  type ElicitationToolName,
  type SupabaseMcpServerOptions,
} from '@supabase/mcp-server-supabase';
import type * as Supabase from '@supabase/mcp-server-supabase';
import {
  createMcpServer,
  tool,
  type McpServerOptions,
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

type Fact = Readonly<{ kind: 'operation'; phase: 'started' | 'finished' }>;

const observer: Utils.RequestObserver<'named', Fact> = (context) => {
  if (context.method === 'tools/call') {
    const bucket: 'named' | 'other' = context.tool;
    void bucket;
  } else {
    // @ts-expect-error Non-call contexts have no tool field.
    void context.tool;
  }
  return {
    record: async (fact) => {
      const phase: 'started' | 'finished' = fact.phase;
      void phase;
    },
    end: (result) => {
      void result.durationMs;
    },
  };
};
const observedTool = tool({
  description: 'Typed observation controls',
  parameters: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (
    _params,
    _context,
    observation?: Utils.ToolObservation<Fact>
  ) => {
    observation?.record({ kind: 'operation', phase: 'started' });
    observation?.setOutcome('completed');
    // @ts-expect-error The producer cannot end the handler-owned scope.
    observation?.end();
    // @ts-expect-error Custom facts must match the declared contract.
    observation?.record({ kind: 'raw', payload: 'unexpected' });
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
const coreOptions: McpServerOptions<'named', Fact> = {
  name: 'packed-observer',
  version: '0.0.0',
  observer,
  classifyTool: (name) => (name === 'observed' ? 'named' : 'other'),
  tools: { observed: observedTool },
};
void createMcpServer(coreOptions);

const sqlFeature: Supabase.ConfirmationFeature = 'destructive_sql';
const sqlFacts = [
  {
    kind: 'confirmation_decision',
    feature: sqlFeature,
    route: 'bypass',
    reason: 'not_destructive',
  },
  { kind: 'operation', feature: sqlFeature, disposition: 'started' },
  {
    kind: 'operation',
    feature: sqlFeature,
    disposition: 'returned',
    durationMs: 1,
  },
  {
    kind: 'operation',
    feature: sqlFeature,
    disposition: 'threw',
    durationMs: 2,
  },
] satisfies Supabase.ObservationFact[];
void sqlFacts;
const supabaseObserver: Supabase.RequestObserver = (context) => {
  if (context.method === 'tools/call') {
    const tool:
      | 'create_project'
      | 'create_branch'
      | 'execute_sql'
      | 'apply_migration'
      | 'other' = context.tool;
    void tool;
  } else {
    // @ts-expect-error Supabase non-call contexts have no tool field.
    void context.tool;
  }
  return {
    record: (fact) => {
      const feature: 'cost' | 'destructive_sql' = fact.feature;
      void feature;
      if (fact.kind === 'operation' && fact.disposition !== 'started') {
        const durationMs: number = fact.durationMs;
        void durationMs;
      }
    },
    end: (result) => {
      void result.durationMs;
    },
  };
};
const observedSupabaseOptions: SupabaseMcpServerOptions = {
  ...options,
  observer: supabaseObserver,
};
void createSupabaseMcpServer(observedSupabaseOptions);
void createSupabaseMcpHandler(observedSupabaseOptions);
