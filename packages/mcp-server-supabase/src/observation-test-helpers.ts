import {
  Client,
  isInputRequiredResult,
  StreamableHTTPClientTransport,
  type CallToolRequestParams,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type InputResponses,
} from '@modelcontextprotocol/client';
import type * as ServerSdk from '@modelcontextprotocol/server';
import { StreamTransport } from '@supabase/mcp-utils';
import { afterEach, expect, vi } from 'vitest';
import type {
  ObservationContext,
  ObservationEnd,
  ObservationFact,
  RequestObserver,
} from './index.js';
import type { Branch, Project, SupabasePlatform } from './platform/types.js';
import * as pricing from './pricing.js';
import {
  createSupabaseMcpServer,
  type SupabaseMcpServerOptions,
} from './server.js';
import { createSupabaseMcpHandler } from './transports/http.js';

// Fail only issuance, retaining the real SDK codec and verification path.
const mintControl = vi.hoisted(() => ({ fail: false }));
vi.mock('@modelcontextprotocol/server', async (importOriginal) => {
  const actual = await importOriginal<typeof ServerSdk>();
  return {
    ...actual,
    createRequestStateCodec: ((
      ...args: Parameters<typeof actual.createRequestStateCodec>
    ) => {
      const codec = actual.createRequestStateCodec(...args);
      return {
        ...codec,
        mint: (...mintArgs: Parameters<typeof codec.mint>) => {
          if (mintControl.fail) throw new Error('PRIVATE_MINT_FAILURE');
          return codec.mint(...mintArgs);
        },
      };
    }) as typeof actual.createRequestStateCodec,
  };
});

const confirmation = {
  requestStateKey: 'a'.repeat(32),
  principal: 'PRIVATE_PRINCIPAL',
  ttlSeconds: 60,
  enabledTools: ['create_project', 'create_branch'],
} satisfies NonNullable<SupabaseMcpServerOptions['costConfirmation']>;
const form: ClientCapabilities = { elicitation: { form: {} } };
const tools = ['create_project', 'create_branch'] as const;
type CostTool = (typeof tools)[number];
type Attempt = {
  context: ObservationContext;
  facts: ObservationFact[];
  ends: ObservationEnd[];
};
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  mintControl.fail = false;
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

function fakePlatform() {
  const project: Project = {
    id: 'PRIVATE_PROJECT',
    ref: 'PRIVATE_PROJECT',
    organization_id: 'PRIVATE_ORG',
    organization_slug: 'PRIVATE_SLUG',
    name: 'PRIVATE_NAME',
    status: 'ACTIVE_HEALTHY',
    created_at: '2026-01-01',
    region: 'us-east-1',
  };
  const branch: Branch = {
    id: 'PRIVATE_BRANCH',
    name: 'PRIVATE_NAME',
    project_ref: 'PRIVATE_BRANCH_REF',
    parent_project_ref: project.id,
    is_default: false,
    persistent: false,
    status: 'CREATING_PROJECT',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  };
  const createProject = vi.fn(async () => project);
  const createBranch = vi.fn(async () => branch);
  const platform = {
    account: {
      listOrganizations: vi.fn(async () => []),
      getOrganization: vi.fn(async () => ({
        id: 'PRIVATE_ORG',
        name: 'PRIVATE_ORG_NAME',
        plan: 'pro',
        allowed_release_channels: [],
        opt_in_tags: [],
      })),
      listProjects: vi.fn(async () => [project]),
      getProject: vi.fn(async () => project),
      createProject,
      pauseProject: vi.fn(async () => {}),
      restoreProject: vi.fn(async () => {}),
    },
    branching: {
      createBranch,
      listBranches: vi.fn(async () => []),
      deleteBranch: vi.fn(async () => {}),
      mergeBranch: vi.fn(async () => {}),
      resetBranch: vi.fn(async () => {}),
      rebaseBranch: vi.fn(async () => {}),
    },
  } satisfies SupabasePlatform;
  return { platform, project, branch, createProject, createBranch };
}

async function setup(
  options: {
    legacy?: boolean;
    capabilities?: ClientCapabilities;
    configured?: boolean;
    injected?: boolean;
    readOnly?: boolean;
    observer?: RequestObserver;
    onToolCall?: SupabaseMcpServerOptions['onToolCall'];
  } = {}
) {
  const fake = fakePlatform();
  const attempts: Attempt[] = [];
  const observer: RequestObserver =
    options.observer ??
    ((context) => {
      const attempt: Attempt = { context, facts: [], ends: [] };
      attempts.push(attempt);
      return {
        record: (fact) => {
          attempt.facts.push(fact);
        },
        end: (end) => {
          attempt.ends.push(end);
        },
      };
    });
  const serverOptions: SupabaseMcpServerOptions = {
    platform: fake.platform,
    features: ['account', 'branching'],
    projectId: options.injected ? fake.project.id : undefined,
    readOnly: options.readOnly,
    costConfirmation: options.configured === false ? undefined : confirmation,
    observer,
    onToolCall: options.onToolCall,
  };
  const client = new Client(
    { name: 'PRIVATE_CLIENT', version: '1.0' },
    {
      capabilities: options.capabilities ?? form,
      ...(options.legacy
        ? {}
        : {
            versionNegotiation: { mode: { pin: '2026-07-28' } },
            inputRequired: { autoFulfill: false },
          }),
    }
  );
  if (options.legacy) {
    const clientTransport = new StreamTransport();
    const serverTransport = new StreamTransport();
    const pipes = Promise.allSettled([
      clientTransport.readable.pipeTo(serverTransport.writable),
      serverTransport.readable.pipeTo(clientTransport.writable),
    ]);
    const server = createSupabaseMcpServer(serverOptions);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
      for (const result of await pipes) {
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({ message: 'connection closed' });
        }
      }
    });
  } else {
    const handler = createSupabaseMcpHandler(serverOptions);
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL('https://PRIVATE_URL.test/mcp'),
        {
          fetch: (url, init) => handler.fetch(new Request(url, init)),
        }
      )
    );
    cleanups.push(() => client.close());
  }
  attempts.length = 0;
  function args(name: CostTool): Record<string, unknown> {
    return name === 'create_project'
      ? {
          name: 'PRIVATE_NAME',
          region: 'us-east-1',
          organization_id: 'PRIVATE_ORG',
        }
      : {
          name: 'PRIVATE_NAME',
          ...(options.injected ? {} : { project_id: fake.project.id }),
        };
  }
  async function call(
    name: CostTool,
    extra: Partial<CallToolRequestParams> &
      Pick<InputRequiredResult, 'requestState'> & {
        inputResponses?: InputResponses;
      } = {}
  ) {
    return (await client.request(
      {
        method: 'tools/call',
        params: { name, arguments: args(name), ...extra },
      },
      { allowInputRequired: true }
    )) as CallToolResult | InputRequiredResult;
  }
  function operation(name: CostTool) {
    return name === 'create_project' ? fake.createProject : fake.createBranch;
  }
  return { ...fake, client, attempts, args, call, operation };
}

function issued(
  result: CallToolResult | InputRequiredResult
): InputRequiredResult {
  expect(isInputRequiredResult(result)).toBe(true);
  if (!isInputRequiredResult(result))
    throw new Error('expected input_required');
  return result;
}
function decision(
  route: 'inline' | 'legacy' | 'bypass' | 'blocked',
  reason:
    | 'eligible'
    | 'not_configured'
    | 'capability_missing'
    | 'read_only'
    | 'zero_cost'
): ObservationFact {
  return { kind: 'confirmation_decision', feature: 'cost', route, reason };
}
function required(
  reason: 'initial' | 'missing_response' | 'changed_quote'
): ObservationFact {
  return { kind: 'input_required', feature: 'cost', mode: 'form', reason };
}
function validation(
  result:
    | 'valid'
    | 'missing_response'
    | 'tool_mismatch'
    | 'arguments_mismatch'
    | 'changed_quote'
): ObservationFact {
  return { kind: 'resume_validation', feature: 'cost', result };
}
function response(action: 'accept' | 'decline' | 'cancel'): ObservationFact {
  return { kind: 'input_response', feature: 'cost', action };
}
const started: ObservationFact = {
  kind: 'operation',
  feature: 'cost',
  disposition: 'started',
};
function operationEnd(disposition: 'returned' | 'threw') {
  return {
    kind: 'operation',
    feature: 'cost',
    disposition,
    durationMs: expect.any(Number),
  };
}
function assertAttempt(
  attempt: Attempt | undefined,
  name: CostTool,
  facts: unknown[],
  result: ObservationEnd['result']
) {
  expect(attempt).toEqual({
    context: { method: 'tools/call', tool: name },
    facts,
    ends: [{ result, durationMs: expect.any(Number) }],
  });
  for (const event of [...attempt!.facts, ...attempt!.ends]) {
    if ('durationMs' in event) {
      expect(Number.isFinite(event.durationMs)).toBe(true);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
  }
}
function changeQuote(name: CostTool) {
  if (name === 'create_project')
    vi.spyOn(pricing, 'getNextProjectCost').mockResolvedValue({
      type: 'project',
      recurrence: 'monthly',
      amount: 20,
    });
  else
    vi.spyOn(pricing, 'getBranchCost').mockReturnValue({
      type: 'branch',
      recurrence: 'hourly',
      amount: 0.02,
    });
}

export {
  mintControl,
  form,
  tools,
  setup,
  issued,
  decision,
  required,
  validation,
  response,
  started,
  operationEnd,
  assertAttempt,
  changeQuote,
};
