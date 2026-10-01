import {
  isInputRequiredResult,
  type CallToolRequestParams,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type InputResponses,
} from '@modelcontextprotocol/client';
import { afterEach, expect, vi } from 'vitest';
import { callModernTool, createServerHarness } from '../test/server-harness.js';
import type {
  ObservationContext,
  ObservationEnd,
  ObservationFact,
  RequestObserver,
} from './index.js';
import type { Branch, Project, SupabasePlatform } from './platform/types.js';
import * as pricing from './pricing.js';
import type { SupabaseMcpServerOptions } from './server.js';

const confirmation = {
  requestState: {
    key: 'a'.repeat(32),
    principal: 'PRIVATE_PRINCIPAL',
    ttlSeconds: 60,
  },
  confirmation: { enabledTools: ['create_project', 'create_branch'] },
} satisfies NonNullable<SupabaseMcpServerOptions['elicitation']>;
const form: ClientCapabilities = { elicitation: { form: {} } };
const tools = ['create_project', 'create_branch'] as const;
type CostTool = (typeof tools)[number];
type Attempt = {
  context: ObservationContext;
  facts: ObservationFact[];
  ends: ObservationEnd[];
};
const harness = createServerHarness();

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await harness.close();
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
    elicitation: options.configured === false ? undefined : confirmation,
    observer,
    onToolCall: options.onToolCall,
  };
  const { client } = await (options.legacy
    ? harness.setup
    : harness.setupModern)({
    ...serverOptions,
    clientCapabilities: options.capabilities ?? form,
  });
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
    return callModernTool(client, { name, arguments: args(name), ...extra });
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
  route: Extract<ObservationFact, { kind: 'confirmation_decision' }>['route'],
  reason: Extract<ObservationFact, { kind: 'confirmation_decision' }>['reason']
): ObservationFact {
  return { kind: 'confirmation_decision', feature: 'cost', route, reason };
}
function required(
  reason: Extract<ObservationFact, { kind: 'input_required' }>['reason']
): ObservationFact {
  return { kind: 'input_required', feature: 'cost', mode: 'form', reason };
}
function validation(
  result: Extract<ObservationFact, { kind: 'resume_validation' }>['result']
): ObservationFact {
  return { kind: 'resume_validation', feature: 'cost', result };
}
function response(
  action: Extract<ObservationFact, { kind: 'input_response' }>['action']
): ObservationFact {
  return { kind: 'input_response', feature: 'cost', action };
}
const started: ObservationFact = {
  kind: 'operation',
  feature: 'cost',
  disposition: 'started',
};
function operationEnd(
  disposition: Extract<
    ObservationFact,
    { kind: 'operation'; durationMs: number }
  >['disposition']
) {
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
