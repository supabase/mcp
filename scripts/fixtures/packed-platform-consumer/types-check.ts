import {
  createSupabaseMcpHandler,
  CURRENT_ELICITATION_TOOLS,
  type ElicitationToolName,
  type SupabaseMcpServerOptions,
} from '@supabase/mcp-server-supabase';

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
