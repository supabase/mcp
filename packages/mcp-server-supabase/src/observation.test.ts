import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
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
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  ObservationContext,
  ObservationEnd,
  ObservationFact,
  RequestObservation,
  RequestObserver,
} from './index.js';
import type { Branch, Project, SupabasePlatform } from './platform/types.js';
import * as pricing from './pricing.js';
import {
  createSupabaseMcpServer,
  type SupabaseMcpServerOptions,
} from './server.js';
import { createSupabaseMcpHandler } from './transports/http.js';
import { hashObject } from './util.js';

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

describe.each(tools)('%s observation', (name) => {
  test('settles initial issuance immediately, without an operation or a waiting scope', async () => {
    const h = await setup();
    issued(await h.call(name));
    assertAttempt(
      h.attempts[0],
      name,
      [decision('inline', 'eligible'), required('initial')],
      'input_required'
    );
    expect(h.operation(name)).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0]!.ends).toHaveLength(1);
  });

  test.each(['accept', 'decline', 'cancel'] as const)(
    'records consumed %s and the actual operation only',
    async (action) => {
      const h = await setup({ injected: name === 'create_branch' });
      const first = issued(await h.call(name));
      const result = await h.call(name, {
        requestState: first.requestState,
        inputResponses: {
          confirm_cost:
            action === 'accept' ? { action, content: {} } : { action },
        },
      });
      expect(isInputRequiredResult(result)).toBe(false);
      const accepted = action === 'accept';
      assertAttempt(
        h.attempts[1],
        name,
        [
          decision('inline', 'eligible'),
          response(action),
          ...(accepted
            ? [validation('valid'), started, operationEnd('returned')]
            : []),
        ],
        accepted ? 'completed' : action === 'decline' ? 'declined' : 'cancelled'
      );
      expect(h.operation(name)).toHaveBeenCalledTimes(accepted ? 1 : 0);
      if (accepted) expect((result as CallToolResult).isError).not.toBe(true);
    }
  );

  test.each([undefined, { confirm_cost: { roots: [] } }])(
    'reissues missing/non-elicit response without a consumed action',
    async (inputResponses) => {
      const h = await setup();
      const first = issued(await h.call(name));
      issued(
        await h.call(name, { requestState: first.requestState, inputResponses })
      );
      assertAttempt(
        h.attempts[1],
        name,
        [
          decision('inline', 'eligible'),
          validation('missing_response'),
          required('missing_response'),
        ],
        'input_required'
      );
      expect(h.operation(name)).not.toHaveBeenCalled();
    }
  );

  test('accepting a changed quote issues another round rather than executing', async () => {
    const h = await setup();
    const first = issued(await h.call(name));
    changeQuote(name);
    issued(
      await h.call(name, {
        requestState: first.requestState,
        inputResponses: { confirm_cost: { action: 'accept', content: {} } },
      })
    );
    assertAttempt(
      h.attempts[1],
      name,
      [
        decision('inline', 'eligible'),
        response('accept'),
        validation('changed_quote'),
        required('changed_quote'),
      ],
      'input_required'
    );
    expect(h.operation(name)).not.toHaveBeenCalled();
  });

  test.each(['initial', 'missing_response', 'changed_quote'] as const)(
    'failed %s mint does not count an issued round',
    async (reason) => {
      const h = await setup();
      const first =
        reason === 'initial' ? undefined : issued(await h.call(name));
      if (reason === 'changed_quote') changeQuote(name);
      mintControl.fail = true;
      const result = await h.call(
        name,
        first
          ? {
              requestState: first.requestState,
              ...(reason === 'changed_quote'
                ? {
                    inputResponses: {
                      confirm_cost: { action: 'accept' as const, content: {} },
                    },
                  }
                : {}),
            }
          : {}
      );
      expect((result as CallToolResult).isError).toBe(true);
      const prior =
        reason === 'initial'
          ? []
          : reason === 'missing_response'
            ? [validation('missing_response')]
            : [response('accept'), validation('changed_quote')];
      assertAttempt(
        h.attempts.at(-1),
        name,
        [decision('inline', 'eligible'), ...prior],
        'tool_error'
      );
      expect(h.operation(name)).not.toHaveBeenCalled();
    }
  );

  test.each(['tool_mismatch', 'arguments_mismatch'] as const)(
    'rejects %s without consuming accept',
    async (mismatch) => {
      const h = await setup();
      const other =
        name === 'create_project' ? 'create_branch' : 'create_project';
      const first = issued(
        await h.call(mismatch === 'tool_mismatch' ? other : name)
      );
      const result = await h.call(name, {
        requestState: first.requestState,
        arguments: {
          ...h.args(name),
          ...(mismatch === 'arguments_mismatch'
            ? { name: 'CHANGED_PRIVATE_NAME' }
            : {}),
        },
        inputResponses: { confirm_cost: { action: 'accept', content: {} } },
      });
      expect((result as CallToolResult).isError).toBe(true);
      assertAttempt(
        h.attempts[1],
        name,
        [decision('inline', 'eligible'), validation(mismatch)],
        'tool_error'
      );
      expect(h.operation(name)).not.toHaveBeenCalled();
    }
  );

  test.each([
    {
      legacy: true,
      configured: false,
      capabilities: {},
      reason: 'not_configured' as const,
    },
    {
      legacy: false,
      configured: false,
      capabilities: form,
      reason: 'not_configured' as const,
    },
    {
      legacy: true,
      configured: true,
      capabilities: form,
      reason: 'capability_missing' as const,
    },
    {
      legacy: false,
      configured: true,
      capabilities: {},
      reason: 'capability_missing' as const,
    },
    {
      legacy: false,
      configured: true,
      capabilities: { elicitation: { url: {} } },
      reason: 'capability_missing' as const,
    },
  ])(
    'preserves legacy protection: $legacy/$configured/$reason/$capabilities',
    async (options) => {
      const h = await setup(options);
      const cost =
        name === 'create_project'
          ? { type: 'project', recurrence: 'monthly', amount: 10 }
          : pricing.getBranchCost();
      const result = await h.call(name, {
        arguments: { ...h.args(name), confirm_cost_id: await hashObject(cost) },
      });
      expect((result as CallToolResult).isError).not.toBe(true);
      assertAttempt(
        h.attempts[0],
        name,
        [decision('legacy', options.reason), started, operationEnd('returned')],
        'completed'
      );
      expect(h.operation(name)).toHaveBeenCalledTimes(1);
      const failure = await h.call(name, {
        arguments: { ...h.args(name), confirm_cost_id: 'PRIVATE_INVALID_HASH' },
      });
      expect((failure as CallToolResult).isError).toBe(true);
      assertAttempt(
        h.attempts[1],
        name,
        [decision('legacy', options.reason)],
        'tool_error'
      );
      expect(h.operation(name)).toHaveBeenCalledTimes(1);
    }
  );

  test('read-only rejection is the decisive branch', async () => {
    const h = await setup({ readOnly: true });
    expect(((await h.call(name)) as CallToolResult).isError).toBe(true);
    assertAttempt(
      h.attempts[0],
      name,
      [decision('blocked', 'read_only')],
      'tool_error'
    );
    expect(h.operation(name)).not.toHaveBeenCalled();
  });

  test('platform rejection wins over an accepted response', async () => {
    const h = await setup();
    const first = issued(await h.call(name));
    h.operation(name).mockRejectedValueOnce(
      new Error('PRIVATE_PLATFORM_ERROR')
    );
    const result = await h.call(name, {
      requestState: first.requestState,
      inputResponses: { confirm_cost: { action: 'accept', content: {} } },
    });
    expect((result as CallToolResult).isError).toBe(true);
    assertAttempt(
      h.attempts[1],
      name,
      [
        decision('inline', 'eligible'),
        response('accept'),
        validation('valid'),
        started,
        operationEnd('threw'),
      ],
      'tool_error'
    );
    expect(h.operation(name)).toHaveBeenCalledTimes(1);
  });

  test.each(['signature', 'expiry'] as const)(
    'SDK %s rejection creates no additional scope',
    async (kind) => {
      const h = await setup();
      const first = issued(await h.call(name));
      let requestState = first.requestState as string;
      if (kind === 'signature') {
        const segments = requestState.split('.');
        const signature = segments.pop()!;
        segments.push((signature[0] === 'a' ? 'b' : 'a') + signature.slice(1));
        requestState = segments.join('.');
      } else {
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
      }
      await expect(
        h.call(name, {
          requestState,
          inputResponses: { confirm_cost: { action: 'accept', content: {} } },
        })
      ).rejects.toMatchObject({ code: -32602 });
      expect(h.attempts).toHaveLength(1);
      expect(h.operation(name)).not.toHaveBeenCalled();
    }
  );

  test('replaying accepted state counts independent attempts and repeated operations', async () => {
    const h = await setup();
    const first = issued(await h.call(name));
    const resume = {
      requestState: first.requestState,
      inputResponses: {
        confirm_cost: { action: 'accept' as const, content: {} },
      },
    };
    await h.call(name, resume);
    await h.call(name, resume);
    expect(h.attempts).toHaveLength(3);
    for (const attempt of h.attempts.slice(1))
      assertAttempt(
        attempt,
        name,
        [
          decision('inline', 'eligible'),
          response('accept'),
          validation('valid'),
          started,
          operationEnd('returned'),
        ],
        'completed'
      );
    expect(h.operation(name)).toHaveBeenCalledTimes(2);
  });
});

test('only an initial zero-cost project bypasses issuance; zero-cost branches still ask', async () => {
  const h = await setup();
  h.platform.account.listProjects.mockResolvedValue([]);
  expect(((await h.call('create_project')) as CallToolResult).isError).not.toBe(
    true
  );
  assertAttempt(
    h.attempts[0],
    'create_project',
    [decision('bypass', 'zero_cost'), started, operationEnd('returned')],
    'completed'
  );
  vi.spyOn(pricing, 'getBranchCost').mockReturnValue({
    type: 'branch',
    recurrence: 'hourly',
    amount: 0,
  });
  issued(await h.call('create_branch'));
  assertAttempt(
    h.attempts[1],
    'create_branch',
    [decision('inline', 'eligible'), required('initial')],
    'input_required'
  );
  expect(h.createProject).toHaveBeenCalledTimes(1);
  expect(h.createBranch).not.toHaveBeenCalled();
});

test('a quote lookup failure settles the attempt without inventing eligibility', async () => {
  const h = await setup();
  h.platform.account.getOrganization.mockRejectedValueOnce(
    new Error('PRIVATE_QUOTE_ERROR')
  );
  expect(((await h.call('create_project')) as CallToolResult).isError).toBe(
    true
  );
  assertAttempt(h.attempts[0], 'create_project', [], 'tool_error');
  expect(h.createProject).not.toHaveBeenCalled();
});

// Node 20 is supported; Promise.withResolvers is not available there.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('reverse completion keeps operation timings and terminal sequences request-local', async () => {
  const h = await setup();
  const projectFirst = issued(await h.call('create_project'));
  const branchFirst = issued(await h.call('create_branch'));
  let now = 10;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const projectGate = deferred<Project>();
  const branchGate = deferred<Branch>();
  const projectEntered = deferred<void>();
  const branchEntered = deferred<void>();
  h.createProject.mockImplementationOnce(() => {
    projectEntered.resolve();
    return projectGate.promise;
  });
  h.createBranch.mockImplementationOnce(() => {
    branchEntered.resolve();
    return branchGate.promise;
  });
  const projectCall = h.call('create_project', {
    requestState: projectFirst.requestState,
    inputResponses: { confirm_cost: { action: 'accept', content: {} } },
  });
  await projectEntered.promise;
  now = 20;
  const branchCall = h.call('create_branch', {
    requestState: branchFirst.requestState,
    inputResponses: { confirm_cost: { action: 'accept', content: {} } },
  });
  await branchEntered.promise;
  now = 30;
  branchGate.resolve(h.branch);
  await branchCall;
  expect(h.attempts[2]!.ends).toEqual([]);
  expect(h.attempts[3]!.ends).toEqual([
    { result: 'completed', durationMs: 10 },
  ]);
  now = 50;
  projectGate.resolve(h.project);
  await projectCall;
  expect(h.attempts[2]!.ends).toEqual([
    { result: 'completed', durationMs: 40 },
  ]);
  expect(h.attempts[2]!.facts.at(-1)).toEqual({
    kind: 'operation',
    feature: 'cost',
    disposition: 'returned',
    durationMs: 40,
  });
  expect(h.attempts[3]!.facts.at(-1)).toEqual({
    kind: 'operation',
    feature: 'cost',
    disposition: 'returned',
    durationMs: 10,
  });
  expect(h.createProject).toHaveBeenCalledTimes(1);
  expect(h.createBranch).toHaveBeenCalledTimes(1);
});

const failures = ['throw', 'reject', 'then_getter', 'never'] as const;
function sinkFailure(kind: (typeof failures)[number]): unknown {
  if (kind === 'throw') throw new Error('PRIVATE_SINK_ERROR');
  if (kind === 'reject')
    return Promise.reject(new Error('PRIVATE_SINK_REJECTION'));
  if (kind === 'then_getter')
    return Object.defineProperty({}, 'then', {
      get() {
        throw new Error('PRIVATE_THENABLE_ERROR');
      },
    });
  return new Promise(() => {});
}

describe.each(['factory', 'record', 'end'] as const)(
  '%s failure isolation through public server',
  (target) => {
    test.each(failures)(
      '%s preserves platform return/error and onToolCall',
      async (failure) => {
        const onToolCall = vi.fn();
        const observer = (() => {
          if (target === 'factory') return sinkFailure(failure);
          return {
            record: () =>
              target === 'record' ? sinkFailure(failure) : undefined,
            end: () => (target === 'end' ? sinkFailure(failure) : undefined),
          };
        }) as RequestObserver;
        const h = await setup({ observer, onToolCall });
        h.platform.account.listProjects.mockResolvedValue([]);
        const success = await h.call('create_project');
        expect((success as CallToolResult).isError).not.toBe(true);
        expect((success as CallToolResult).content).toEqual([
          { type: 'text', text: JSON.stringify(h.project) },
        ]);
        h.createProject.mockRejectedValueOnce(
          new Error('PRIVATE_BUSINESS_ERROR')
        );
        const failureResult = await h.call('create_project');
        expect((failureResult as CallToolResult).isError).toBe(true);
        expect(JSON.stringify(failureResult)).toContain(
          'PRIVATE_BUSINESS_ERROR'
        );
        expect(h.createProject).toHaveBeenCalledTimes(2);
        expect(onToolCall).toHaveBeenCalledTimes(2);
        expect(onToolCall.mock.calls[0]![0]).toMatchObject({
          name: 'create_project',
          arguments: h.args('create_project'),
          success: true,
          data: h.project,
        });
        expect(onToolCall.mock.calls[1]![0]).toMatchObject({
          name: 'create_project',
          arguments: h.args('create_project'),
          success: false,
          error: expect.objectContaining({ message: 'PRIVATE_BUSINESS_ERROR' }),
        });
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      }
    );
  }
);

test.each(['record', 'end'] as const)(
  'throwing %s property access cannot alter cost output',
  async (target) => {
    const observer: RequestObserver = () =>
      Object.defineProperty({ record() {}, end() {} }, target, {
        get() {
          throw new Error('PRIVATE_GETTER');
        },
      }) as RequestObservation;
    const h = await setup({ observer });
    const first = issued(await h.call('create_branch'));
    const result = await h.call('create_branch', {
      requestState: first.requestState,
      inputResponses: { confirm_cost: { action: 'cancel' } },
    });
    expect((result as CallToolResult).structuredContent).toEqual({
      status: 'cancelled',
    });
    expect(h.createBranch).not.toHaveBeenCalled();
  }
);

test('observer DTOs have closed keys and exclude arguments, state, URLs, results and errors', async () => {
  const h = await setup();
  const first = issued(
    await h.call('create_project', {
      arguments: {
        ...h.args('create_project'),
        name: 'PRIVATE_SQL SELECT secret',
      },
      _meta: {
        private: 'PRIVATE_META',
        [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
        [CLIENT_CAPABILITIES_META_KEY]: form,
      },
    })
  );
  h.createProject.mockRejectedValueOnce(
    new Error('PRIVATE_ERROR https://PRIVATE_ERROR_URL.test')
  );
  await h.call('create_project', {
    requestState: first.requestState,
    arguments: {
      ...h.args('create_project'),
      name: 'PRIVATE_SQL SELECT secret',
    },
    inputResponses: { confirm_cost: { action: 'accept', content: {} } },
  });
  expect(JSON.stringify(h.attempts)).not.toContain('PRIVATE_');
  expect(JSON.stringify(h.attempts)).not.toContain(first.requestState);
  const keys = {
    confirmation_decision: ['feature', 'kind', 'reason', 'route'],
    input_required: ['feature', 'kind', 'mode', 'reason'],
    input_response: ['action', 'feature', 'kind'],
    resume_validation: ['feature', 'kind', 'result'],
    operation: ['disposition', 'feature', 'kind'],
  };
  for (const attempt of h.attempts) {
    expect(Object.keys(attempt.context).sort()).toEqual(['method', 'tool']);
    for (const fact of attempt.facts)
      expect(Object.keys(fact).sort()).toEqual(
        [
          ...keys[fact.kind],
          ...('durationMs' in fact ? ['durationMs'] : []),
        ].sort()
      );
    for (const end of attempt.ends)
      expect(Object.keys(end).sort()).toEqual(['durationMs', 'result']);
  }
});

test.each(tools)(
  '%s decline/cancel takes precedence over a changed quote',
  async (name) => {
    const h = await setup();
    const first = issued(await h.call(name));
    changeQuote(name);
    for (const action of ['decline', 'cancel'] as const) {
      const result = await h.call(name, {
        requestState: first.requestState,
        inputResponses: { confirm_cost: { action } },
      });
      expect((result as CallToolResult).structuredContent).toEqual({
        status: action === 'decline' ? 'declined' : 'cancelled',
      });
      assertAttempt(
        h.attempts.at(-1),
        name,
        [decision('inline', 'eligible'), response(action)],
        action === 'decline' ? 'declined' : 'cancelled'
      );
    }
    expect(h.operation(name)).not.toHaveBeenCalled();
  }
);

test.each(tools)(
  '%s legacy platform rejection has operation facts, not a modern validation',
  async (name) => {
    const h = await setup({ legacy: true, capabilities: {} });
    const cost =
      name === 'create_project'
        ? { type: 'project', recurrence: 'monthly', amount: 10 }
        : pricing.getBranchCost();
    h.operation(name).mockRejectedValueOnce(new Error('PRIVATE_LEGACY_ERROR'));
    const result = await h.call(name, {
      arguments: { ...h.args(name), confirm_cost_id: await hashObject(cost) },
    });
    expect((result as CallToolResult).isError).toBe(true);
    assertAttempt(
      h.attempts[0],
      name,
      [
        decision('legacy', 'capability_missing'),
        started,
        operationEnd('threw'),
      ],
      'tool_error'
    );
    expect(h.operation(name)).toHaveBeenCalledTimes(1);
  }
);

test('zero-cost project failure still reports the actual protected call', async () => {
  const h = await setup();
  h.platform.account.listProjects.mockResolvedValue([]);
  h.createProject.mockRejectedValueOnce(new Error('PRIVATE_ZERO_COST_ERROR'));
  expect(((await h.call('create_project')) as CallToolResult).isError).toBe(
    true
  );
  assertAttempt(
    h.attempts[0],
    'create_project',
    [decision('bypass', 'zero_cost'), started, operationEnd('threw')],
    'tool_error'
  );
  expect(h.createProject).toHaveBeenCalledTimes(1);
});
