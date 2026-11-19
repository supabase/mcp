import {
  isInputRequiredResult,
  type CallToolRequestParams,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type InputResponses,
} from '@modelcontextprotocol/client';
import { afterEach, expect, vi } from 'vitest';
import { callModernTool, createServerHarness } from './server-harness.js';
import type {
  ObservationContext,
  ObservationEnd,
  ObservationFact,
  RequestObserver,
} from '../src/index.js';
import type {
  Branch,
  Project,
  SupabasePlatform,
} from '../src/platform/types.js';
import type { SupabaseMcpServerOptions } from '../src/server.js';
import {
  regexClassifier,
  SqlClassifierUnavailableError,
  type SqlConfirmationClassifier,
  withFallback,
} from '../src/sql-confirmation.js';

const confirmation = {
  requestState: {
    key: 'a'.repeat(32),
    principal: 'PRIVATE_PRINCIPAL',
  },
  confirmation: {
    enabledTools: ['create_project', 'create_branch'],
    ttlSeconds: 60,
  },
} satisfies NonNullable<SupabaseMcpServerOptions['elicitation']>;
const form: ClientCapabilities = { elicitation: { form: {} } };
const tools = ['create_project', 'create_branch'] as const;
type CostTool = (typeof tools)[number];
type Attempt = {
  context: ObservationContext;
  facts: ObservationFact[];
  ends: ObservationEnd[];
};
/** Every `result` a `sql_classifier_call` fact can carry, written out by hand. */
type SqlClassifierCallResult =
  | 'not_destructive'
  | 'destructive'
  | 'do_heuristic'
  | 'unclassified'
  | 'oversized'
  | 'unavailable'
  | 'timeout'
  | 'crashed'
  | 'invalid'
  | 'rejected'
  | 'aborted';
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
    database: {
      executeSql: vi.fn(async () => []),
      applyMigration: vi.fn(async () => {}),
      listMigrations: vi.fn(async () => []),
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
    platform?: SupabasePlatform;
    features?: SupabaseMcpServerOptions['features'];
    elicitation?: SupabaseMcpServerOptions['elicitation'];
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
    platform: options.platform ?? fake.platform,
    features: options.features ?? ['account', 'branching', 'database'],
    projectId: options.injected ? fake.project.id : undefined,
    readOnly: options.readOnly,
    elicitation:
      options.elicitation ??
      (options.configured === false ? undefined : confirmation),
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
function factBuilders(
  feature: Extract<
    ObservationFact,
    { kind: 'confirmation_decision' }
  >['feature']
) {
  function decision(
    route: Extract<ObservationFact, { kind: 'confirmation_decision' }>['route'],
    reason: Extract<
      ObservationFact,
      { kind: 'confirmation_decision' }
    >['reason']
  ): ObservationFact {
    return { kind: 'confirmation_decision', feature, route, reason };
  }
  function required(
    reason: Extract<ObservationFact, { kind: 'input_required' }>['reason']
  ): ObservationFact {
    return { kind: 'input_required', feature, mode: 'form', reason };
  }
  function validation(
    result: Extract<ObservationFact, { kind: 'resume_validation' }>['result']
  ): ObservationFact {
    return { kind: 'resume_validation', feature, result };
  }
  // `input_response` also carries timing (`elapsed_ms`, `instant`) taken from
  // the wall clock; these flow tests don't control it, so they match only the
  // action. confirmation-instant-cancel.test.ts pins the timing fields.
  function response(
    action: Extract<ObservationFact, { kind: 'input_response' }>['action']
  ): unknown {
    return expect.objectContaining({ kind: 'input_response', feature, action });
  }
  const started: ObservationFact = {
    kind: 'operation',
    feature,
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
      feature,
      disposition,
      durationMs: expect.any(Number),
    };
  }
  function classifierCall(result: SqlClassifierCallResult) {
    return {
      kind: 'sql_classifier_call',
      feature,
      result,
      durationMs: expect.any(Number),
    };
  }
  return {
    decision,
    required,
    validation,
    response,
    started,
    operationEnd,
    classifierCall,
  };
}

// Stand-ins for a classifier's own error. Neither may reach a fact.
const privateClassifierError = () =>
  Object.assign(new Error('PRIVATE_CLASSIFIER_MESSAGE'), {
    name: 'PRIVATE_CLASSIFIER_NAME',
  });
const returning = (value: unknown) =>
  (async () => value) as unknown as SqlConfirmationClassifier;

// Results whose inspection throws what the classifier's own code threw.
const failureGetterThrows = {
  get failure(): never {
    throw privateClassifierError();
  },
};
const trapsThrow = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === 'then') return undefined;
      throw privateClassifierError();
    },
    has() {
      throw privateClassifierError();
    },
    ownKeys() {
      throw privateClassifierError();
    },
    getOwnPropertyDescriptor() {
      throw privateClassifierError();
    },
    getPrototypeOf() {
      throw privateClassifierError();
    },
  }
);

type ClassifierOutcome = {
  /** Reads after "when the classifier". */
  label: string;
  classify: SqlConfirmationClassifier;
  /** The `result` the `sql_classifier_call` fact carries for this outcome. */
  result: SqlClassifierCallResult;
  /** What the classifier's answer means: the SQL needs no confirmation, needs one, or cannot be checked. */
  verdict: 'clears' | 'flags' | 'fails';
  /** Another input for a `result` an earlier row already covers. */
  variant?: true;
};

/**
 * One row per classifier outcome and the `sql_classifier_call` result it maps
 * to. Each result has one main row; `variant` rows are further inputs that
 * must map to the same result.
 */
const classifierOutcomes: readonly ClassifierOutcome[] = [
  {
    label: 'returns undefined',
    classify: returning(undefined),
    result: 'not_destructive',
    verdict: 'clears',
  },
  {
    label: 'returns destructive',
    classify: returning('destructive'),
    result: 'destructive',
    verdict: 'flags',
  },
  {
    label: 'returns do-heuristic',
    classify: returning('do-heuristic'),
    result: 'do_heuristic',
    verdict: 'flags',
  },
  {
    label: 'returns unclassified',
    classify: returning('unclassified'),
    result: 'unclassified',
    verdict: 'flags',
  },
  {
    label: 'returns an oversized failure',
    classify: returning({ failure: 'oversized' }),
    result: 'oversized',
    verdict: 'flags',
  },
  {
    label: 'returns an unavailable failure',
    classify: returning({ failure: 'unavailable' }),
    result: 'unavailable',
    verdict: 'fails',
  },
  {
    label: 'returns a timeout failure',
    classify: returning({ failure: 'timeout' }),
    result: 'timeout',
    verdict: 'fails',
  },
  {
    label: 'returns a crashed failure',
    classify: returning({ failure: 'crashed' }),
    result: 'crashed',
    verdict: 'fails',
  },
  // Results outside the contract, for example one that crossed IPC.
  {
    label: 'returns null',
    classify: returning(null),
    result: 'invalid',
    verdict: 'fails',
  },
  {
    label: 'returns false',
    classify: returning(false),
    result: 'invalid',
    verdict: 'fails',
    variant: true,
  },
  {
    label: 'returns an unknown reason',
    classify: returning('PRIVATE_UNKNOWN_REASON'),
    result: 'invalid',
    verdict: 'fails',
    variant: true,
  },
  {
    label: 'returns an unknown failure kind',
    classify: returning({ failure: 'PRIVATE_FAILURE_KIND' }),
    result: 'invalid',
    verdict: 'fails',
    variant: true,
  },
  {
    label: 'returns a failure with extra keys',
    classify: returning({ failure: 'oversized', detail: 'PRIVATE_DETAIL' }),
    result: 'invalid',
    verdict: 'fails',
    variant: true,
  },
  // `withFallback` passes a near-miss failure through, so the step sees the
  // value itself and not a rejection.
  {
    label: 'returns an unknown failure kind through withFallback',
    classify: withFallback(
      returning({ failure: 'PRIVATE_FAILURE_KIND' }),
      regexClassifier
    ),
    result: 'invalid',
    verdict: 'fails',
    variant: true,
  },
  {
    label:
      'returns an unavailable failure with extra keys through withFallback',
    classify: withFallback(
      returning({ failure: 'unavailable', detail: 'PRIVATE_DETAIL' }),
      regexClassifier
    ),
    result: 'invalid',
    verdict: 'fails',
    variant: true,
  },
  {
    label: 'returns an array through withFallback',
    classify: withFallback(returning(['unavailable']), regexClassifier),
    result: 'invalid',
    verdict: 'fails',
    variant: true,
  },
  // Results whose inspection throws. `then` stays readable, so the
  // classifier's promise resolves with the value instead of rejecting.
  {
    label: 'returns an object whose failure getter throws',
    classify: returning(failureGetterThrows),
    result: 'invalid',
    verdict: 'fails',
    variant: true,
  },
  {
    label: 'returns a proxy whose traps throw',
    classify: returning(trapsThrow),
    result: 'invalid',
    verdict: 'fails',
    variant: true,
  },
  // `withFallback` passes such a result through too: what reading it throws
  // is not the classifier's rejection.
  {
    label: 'returns an object whose failure getter throws through withFallback',
    classify: withFallback(returning(failureGetterThrows), regexClassifier),
    result: 'invalid',
    verdict: 'fails',
    variant: true,
  },
  {
    label: 'returns a proxy whose traps throw through withFallback',
    classify: withFallback(returning(trapsThrow), regexClassifier),
    result: 'invalid',
    verdict: 'fails',
    variant: true,
  },
  {
    label: 'rejects',
    classify: async () => {
      throw privateClassifierError();
    },
    result: 'rejected',
    verdict: 'fails',
  },
  {
    label: 'throws synchronously',
    classify: () => {
      throw privateClassifierError();
    },
    result: 'rejected',
    verdict: 'fails',
    variant: true,
  },
  // Only `withFallback` reads this error; on its own it is one more rejection.
  {
    label: 'rejects with SqlClassifierUnavailableError',
    classify: async () => {
      throw new SqlClassifierUnavailableError('PRIVATE_CLASSIFIER_MESSAGE');
    },
    result: 'rejected',
    verdict: 'fails',
    variant: true,
  },
  {
    label: 'rejects with a string',
    classify: async () => {
      throw 'PRIVATE_CLASSIFIER_MESSAGE';
    },
    result: 'rejected',
    verdict: 'fails',
    variant: true,
  },
];
function assertAttempt(
  attempt: Attempt | undefined,
  name: Extract<ObservationContext, { method: 'tools/call' }>['tool'],
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

export {
  form,
  tools,
  setup,
  issued,
  factBuilders,
  assertAttempt,
  fakePlatform,
  classifierOutcomes,
  privateClassifierError,
};
