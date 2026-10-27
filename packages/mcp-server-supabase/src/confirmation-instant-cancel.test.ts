import {
  isInputRequiredResult,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type InputResponses,
} from '@modelcontextprotocol/client';
import {
  createRequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { describe, expect, test, vi } from 'vitest';
import {
  fakePlatform,
  issued,
  setup as setupObservation,
} from '../test/observation-test-helpers.js';
import { expectTerminalResult } from '../test/confirmation-results.js';
import { callModernTool } from '../test/server-harness.js';
import type { ObservationEnd, ObservationFact } from './index.js';
import type {
  NotebookWithContent,
  SupabasePlatform,
} from './platform/types.js';
import * as pricing from './pricing.js';
import { hashObject } from './util.js';

// AI-1328: confirmation cancels record how long the client took (`elapsed_ms`)
// and flag sub-second ones as `instant`. Every cancel returns the same text,
// whatever its timing. Every expected value below is a hand-written literal
// from the approved spec.

const KEY = 'a'.repeat(32);
const PRINCIPAL = 'PRIVATE_PRINCIPAL';
// 2030-01-01T00:00:00.250Z. The 250 ms part catches an issued_at floored to
// whole seconds.
const T0 = 1_893_456_000_250;
const projectId = 'PRIVATE_PROJECT';
const updatedAt = '2026-01-01T00:00:00.000Z';

const tools = [
  'execute_sql',
  'apply_migration',
  'run_notebook',
  'create_project',
  'create_branch',
] as const;
type Tool = (typeof tools)[number];

const requestKey = {
  execute_sql: 'confirm_destructive',
  apply_migration: 'confirm_destructive',
  run_notebook: 'confirm_run',
  create_project: 'confirm_cost',
  create_branch: 'confirm_cost',
} as const satisfies Record<Tool, string>;

const feature = {
  execute_sql: 'destructive_sql',
  apply_migration: 'destructive_sql',
  run_notebook: 'notebook',
  create_project: 'cost',
  create_branch: 'cost',
} as const satisfies Record<Tool, ObservationFact['feature']>;

// AI-1372: hand-written from the spec. The tool name is the one being
// called; the lifetime is the default 600 s TTL.
const expiredMessage = {
  execute_sql:
    'This confirmation expired after 10 minutes. Call `execute_sql` again to get a new confirmation.',
  apply_migration:
    'This confirmation expired after 10 minutes. Call `apply_migration` again to get a new confirmation.',
  run_notebook:
    'This confirmation expired after 10 minutes. Call `run_notebook` again to get a new confirmation.',
  create_project:
    'This confirmation expired after 10 minutes. Call `create_project` again to get a new confirmation.',
  create_branch:
    'This confirmation expired after 10 minutes. Call `create_branch` again to get a new confirmation.',
} as const satisfies Record<Tool, string>;

const args = {
  execute_sql: {
    project_id: projectId,
    query: 'DROP TABLE "PRIVATE_TABLE";',
  },
  apply_migration: {
    project_id: projectId,
    name: 'PRIVATE_MIGRATION',
    query: 'DROP TABLE "PRIVATE_TABLE";',
  },
  run_notebook: {
    project_id: projectId,
    notebook_id: 'PRIVATE_NOTEBOOK',
    expected_updated_at: updatedAt,
  },
  create_project: {
    name: 'PRIVATE_NAME',
    region: 'us-east-1',
    organization_id: 'PRIVATE_ORG',
  },
  create_branch: { name: 'PRIVATE_NAME', project_id: projectId },
} as const satisfies Record<Tool, Record<string, unknown>>;

const notebook: NotebookWithContent = {
  id: 'PRIVATE_NOTEBOOK',
  name: 'PRIVATE_NOTEBOOK_NAME',
  description: null,
  favorite: false,
  inserted_at: updatedAt,
  updated_at: updatedAt,
  owner: null,
  updated_by: null,
  content: {
    schema_version: 1,
    cells: [
      {
        id: 'write',
        type: 'database',
        sql: 'DELETE FROM PRIVATE_TABLE',
        row_limit: 10,
      },
    ],
  },
};

type Harness = {
  attempts: Array<{ facts: ObservationFact[]; ends: ObservationEnd[] }>;
  /** Every platform call that would run, apply or create something. */
  operations: unknown[];
  /** The platform call each tool's accepted confirmation makes. */
  operation: Record<Tool, unknown>;
  createBranch: unknown;
  setNow(value: number): void;
  /** Advance the clock by `ms` on every platform read from now on. */
  delayReads(ms: number): void;
  /** Make every account and notebook read throw from now on. */
  failReads(): void;
  /** Serve `value` from getNotebook from now on. */
  setNotebook(value: NotebookWithContent): void;
  call(
    name: Tool,
    extra?: CallExtra
  ): Promise<CallToolResult | InputRequiredResult>;
  /** Like `call`, through the resume client when `resumeCapabilities` is set. */
  resumeCall(
    name: Tool,
    extra?: CallExtra
  ): Promise<CallToolResult | InputRequiredResult>;
};

type CallExtra = {
  arguments?: Record<string, unknown>;
  requestState?: string;
  inputResponses?: InputResponses;
};

async function setup(
  options: { ttlSeconds?: number; resumeCapabilities?: ClientCapabilities } = {}
): Promise<Harness> {
  const fake = fakePlatform();
  let now = T0;
  let readDelay = 0;
  let readsFail = false;
  let currentNotebook = notebook;
  // Platform reads advance the mocked clock so a test can model a resume
  // whose server-side work takes time.
  function slowRead<A extends unknown[], R>(read: (...a: A) => R) {
    return (...a: A) => {
      now += readDelay;
      if (readsFail) throw new Error('PRIVATE_READ_FAILED');
      return read(...a);
    };
  }
  const { account } = fake.platform;
  const platform = {
    ...fake.platform,
    account: {
      ...account,
      getOrganization: slowRead(account.getOrganization),
      listOrganizations: slowRead(account.listOrganizations),
      listProjects: slowRead(account.listProjects),
      getProject: slowRead(account.getProject),
    },
    notebooks: {
      getNotebook: slowRead(async () => currentNotebook),
      listNotebooks: vi.fn(async () => []),
    },
  } satisfies SupabasePlatform;
  const features = ['account', 'branching', 'database', 'notebooks'];
  const elicitation = {
    requestState: {
      key: KEY,
      principal: PRINCIPAL,
      ...(options.ttlSeconds === undefined
        ? {}
        : { ttlSeconds: options.ttlSeconds }),
    },
    confirmation: { enabledTools: [...tools] },
  };
  const main = await setupObservation({ platform, features, elicitation });
  // A second server with the same key and principal, so state minted on the
  // form client verifies here too; only the client capabilities differ.
  const resumer =
    options.resumeCapabilities === undefined
      ? main
      : await setupObservation({
          platform,
          features,
          elicitation,
          capabilities: options.resumeCapabilities,
        });
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    attempts: resumer.attempts,
    operations: [
      platform.database.executeSql,
      platform.database.applyMigration,
      fake.createProject,
      fake.createBranch,
    ],
    operation: {
      execute_sql: platform.database.executeSql,
      apply_migration: platform.database.applyMigration,
      run_notebook: platform.database.executeSql,
      create_project: fake.createProject,
      create_branch: fake.createBranch,
    },
    createBranch: fake.createBranch,
    setNow(value) {
      now = value;
    },
    delayReads(ms) {
      readDelay = ms;
    },
    failReads() {
      readsFail = true;
    },
    setNotebook(value) {
      currentNotebook = value;
    },
    call: (name, extra = {}) =>
      callModernTool(main.client, { name, arguments: args[name], ...extra }),
    resumeCall: (name, extra = {}) =>
      callModernTool(resumer.client, {
        name,
        arguments: args[name],
        ...extra,
      }),
  };
}

/** Decoded signed payload (`p`) of a requestState envelope. */
function payload(state: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(state!.split('.')[1]!, 'base64url').toString())
    .p;
}

/**
 * Issue at T0, then resume with `action` at T0 + gap (through the resume
 * client when `resumeCapabilities` is set).
 */
async function resume(
  h: Harness,
  name: Tool,
  action: 'accept' | 'decline' | 'cancel',
  gap: number,
  requestState?: string
) {
  h.setNow(T0);
  const state = requestState ?? issued(await h.call(name)).requestState;
  h.setNow(T0 + gap);
  const result = await h.resumeCall(name, {
    requestState: state,
    inputResponses: {
      [requestKey[name]]:
        action === 'accept' ? { action, content: {} } : { action },
    },
  });
  expect(isInputRequiredResult(result)).toBe(false);
  return result as CallToolResult;
}

function inputResponseFacts(h: Harness) {
  return h.attempts.at(-1)!.facts.filter((f) => f.kind === 'input_response');
}

function validationFacts(h: Harness) {
  return h.attempts.at(-1)!.facts.filter((f) => f.kind === 'resume_validation');
}

function expectNothingRan(h: Harness) {
  for (const operation of h.operations)
    expect(operation).not.toHaveBeenCalled();
}

describe.each(tools)('%s confirmation requestState', (name) => {
  // Regression: issued_at missing from the minted state, floored to whole
  // seconds, or copied from the old state on a reprompt (the secret flow
  // preserves its issued_at on purpose, so copying that pattern is plausible).
  // No existing test decodes a confirmation requestState.
  test('mints a millisecond issued_at, fresh on a missing-response reprompt', async () => {
    const h = await setup();
    const first = issued(await h.call(name));
    expect(payload(first.requestState).issued_at).toBe(1_893_456_000_250);

    h.setNow(T0 + 5_000);
    const second = issued(
      await h.call(name, { requestState: first.requestState })
    );
    expect(payload(second.requestState).issued_at).toBe(1_893_456_005_250);
  });

  // Regression: the cancel message drops the timing sentence, states the
  // wrong gap, switches wording at the 1000 ms instant threshold, brings back
  // a per-tool sentence instead of "Nothing was run.", drops the message from
  // either result channel, mis-records the fact, or runs/creates something.
  test.each([
    {
      gap: 550,
      instant: true,
      message:
        "The client cancelled this confirmation 0.6 s after it was sent. Nothing was run. If you didn't see a confirmation prompt, your client may have cancelled it automatically.",
    },
    {
      gap: 1_000,
      instant: false,
      message:
        "The client cancelled this confirmation 1.0 s after it was sent. Nothing was run. If you didn't see a confirmation prompt, your client may have cancelled it automatically.",
    },
  ])(
    'a cancel after $gap ms states the gap and runs nothing',
    async ({ gap, instant, message }) => {
      const h = await setup();
      const result = await resume(h, name, 'cancel', gap);
      expectTerminalResult(result, 'cancelled', message);
      expect(inputResponseFacts(h)).toEqual([
        {
          kind: 'input_response',
          feature: feature[name],
          action: 'cancel',
          elapsed_ms: gap,
          ...(instant ? { instant: true } : {}),
        },
      ]);
      expect(h.attempts.at(-1)!.ends).toEqual([
        expect.objectContaining({ result: 'cancelled' }),
      ]);
      expectNothingRan(h);
    }
  );

  // AI-1372 (SU-519683). Regression: a resume whose requestState has a valid
  // MAC but is past its expiry comes back as JSON-RPC -32602 again (the agent
  // sees "Invalid or expired requestState" and can't tell the user why), or
  // the operation runs anyway, or the message names the wrong tool or
  // lifetime, or the `expired` validation fact is missing.
  // Default TTL is 600 s; exp = floor(T0 / 1000) + 600, so T0 + 601 s is the
  // first whole second the codec treats as expired.
  test('an expired resume returns the expired tool result and runs nothing', async () => {
    const h = await setup();
    const result = await resume(h, name, 'accept', 601_000);
    expectTerminalResult(result, 'expired', expiredMessage[name]);
    expect(validationFacts(h)).toEqual([
      { kind: 'resume_validation', feature: feature[name], result: 'expired' },
    ]);
    expectNothingRan(h);
  });
});

// AI-1372. Regression: an expiry check stricter than the configured TTL.
// Five minutes in is clearly inside the default 10-minute TTL, so this
// doesn't pin the SDK's boundary second.
test('a resume inside the TTL still runs the operation', async () => {
  const h = await setup();
  const result = await resume(h, 'execute_sql', 'accept', 300_000);
  expect(result.isError).not.toBe(true);
  expect(validationFacts(h)).toEqual([
    { kind: 'resume_validation', feature: 'destructive_sql', result: 'valid' },
  ]);
  expect(h.operation.execute_sql).toHaveBeenCalledTimes(1);
});

// Regression: an off-by-one threshold (<= 1000 or < 999), `instant` set on a
// fast decline/accept, or elapsed_ms dropped on non-cancel actions. These are
// the shared threshold and observation contracts, so one tool covers them;
// the 1000 ms side of the boundary lives in the five-tool test above.
// The `message` rows catch rounding mistakes in the cancel message: 949 ms
// reads 1.0 under Math.ceil, and 999 ms reads 0.9 under truncation or prints
// `1` without the decimal. (550 ms reading 0.5 under floor is caught above.)
test.each([
  { action: 'accept', gap: 999, instant: false },
  { action: 'decline', gap: 999, instant: false },
  {
    action: 'cancel',
    gap: 949,
    instant: true,
    message:
      "The client cancelled this confirmation 0.9 s after it was sent. Nothing was run. If you didn't see a confirmation prompt, your client may have cancelled it automatically.",
  },
  {
    action: 'cancel',
    gap: 999,
    instant: true,
    message:
      "The client cancelled this confirmation 1.0 s after it was sent. Nothing was run. If you didn't see a confirmation prompt, your client may have cancelled it automatically.",
  },
] as const)(
  'execute_sql $action after $gap ms records elapsed_ms (instant=$instant)',
  async ({ action, gap, instant, message }) => {
    const h = await setup();
    const result = await resume(h, 'execute_sql', action, gap);
    expect(inputResponseFacts(h)).toEqual([
      {
        kind: 'input_response',
        feature: 'destructive_sql',
        action,
        elapsed_ms: gap,
        ...(instant ? { instant: true } : {}),
      },
    ]);
    if (message !== undefined)
      expectTerminalResult(result, 'cancelled', message);
    if (action !== 'accept') expectNothingRan(h);
  }
);

// Regression: the gap is sampled after the resume's platform reads instead of
// when the request reaches the tool, so a slow organization/project lookup
// pushes a fast cancel past 1000 ms and hides it. No other test makes server
// work take time on the clock.
test('create_project measures the gap at handler entry, before platform reads', async () => {
  const h = await setup();
  const first = issued(await h.call('create_project'));
  h.delayReads(600);
  await resume(h, 'create_project', 'cancel', 550, first.requestState);
  // Precondition: the resume did read the platform, so the clock moved on.
  expect(Date.now()).toBeGreaterThanOrEqual(1_893_456_001_400);
  expect(inputResponseFacts(h)).toEqual([
    {
      kind: 'input_response',
      feature: 'cost',
      action: 'cancel',
      elapsed_ms: 550,
      instant: true,
    },
  ]);
  expectNothingRan(h);
});

// Regression: a resume clocked before issuance (clock skew between servers)
// is flagged instant because the gap is < 1000, records a negative
// elapsed_ms, or gets a different text. Nothing else exercises a negative gap.
test('a negative gap is a cancel without timing', async () => {
  const h = await setup();
  const first = issued(await h.call('execute_sql'));
  // Precondition: the state carries issued_at, so this exercises the negative
  // gap rather than the missing-issued_at path.
  expect(payload(first.requestState).issued_at).toBe(1_893_456_000_250);

  const result = await resume(
    h,
    'execute_sql',
    'cancel',
    -500,
    first.requestState
  );
  expectTerminalResult(
    result,
    'cancelled',
    "Nothing was run. If you didn't see a confirmation prompt, your client may have cancelled it automatically."
  );
  expect(inputResponseFacts(h)).toEqual([
    { kind: 'input_response', feature: 'destructive_sql', action: 'cancel' },
  ]);
  expectNothingRan(h);
});

// Regression: requestState minted before this change (no issued_at) is
// rejected as "not issued" once the schema requires issued_at, is flagged
// instant (NaN/undefined gap), or gets a different text. Re-signing with the
// real codec and the server's key and binding reproduces an in-flight legacy
// state at the public seam; no existing test does.
test('a signed state without issued_at is a cancel without timing', async () => {
  const h = await setup();
  const first = issued(await h.call('execute_sql'));
  const { issued_at, ...legacy } = payload(first.requestState);
  expect(issued_at).toBe(1_893_456_000_250);
  const codec = createRequestStateCodec({
    key: KEY,
    bind: (ctx) => `${ctx.mcpReq.method}:${PRINCIPAL}`,
  });
  const legacyState = await codec.mint(legacy, {
    mcpReq: { method: 'tools/call' },
  } as ServerContext);

  const result = await resume(h, 'execute_sql', 'cancel', 100, legacyState);
  expectTerminalResult(
    result,
    'cancelled',
    "Nothing was run. If you didn't see a confirmation prompt, your client may have cancelled it automatically."
  );
  expect(inputResponseFacts(h)).toEqual([
    { kind: 'input_response', feature: 'destructive_sql', action: 'cancel' },
  ]);
  expectNothingRan(h);
});

// Regression: the changed-quote reprompt reuses the original issued_at, so a
// fast cancel of the *new* prompt is measured from the first one and missed.
// The missing-response reprompt test above takes a different branch.
test('a changed-quote reprompt mints a fresh issued_at', async () => {
  const h = await setup();
  const first = issued(await h.call('create_branch'));
  vi.spyOn(pricing, 'getBranchCost').mockReturnValue({
    type: 'branch',
    recurrence: 'hourly',
    amount: 0.02,
  });
  h.setNow(T0 + 2_000);
  const second = issued(
    await h.call('create_branch', {
      requestState: first.requestState,
      inputResponses: { confirm_cost: { action: 'accept', content: {} } },
    })
  );
  expect(payload(second.requestState).issued_at).toBe(1_893_456_002_250);
  expect(h.createBranch).not.toHaveBeenCalled();
});

// AI-1372. Regression: the lifetime in the expired message is hard-coded to
// the default, drifts from the TTL the codec was built with (platform passes
// 120 when URL-mode secret collection is on), always prints seconds, always
// prints minutes, or gets the singular wrong. One tool covers the shared
// formatter. Each gap is one whole second past exp = floor(T0 / 1000) + ttl.
test.each([
  { ttlSeconds: 120, gap: 121_000, lifetime: '2 minutes' },
  { ttlSeconds: 60, gap: 61_000, lifetime: '1 minute' },
  { ttlSeconds: 90, gap: 91_000, lifetime: '90 seconds' },
  { ttlSeconds: 1, gap: 2_000, lifetime: '1 second' },
])(
  'an expired resume with ttlSeconds $ttlSeconds states $lifetime',
  async ({ ttlSeconds, gap, lifetime }) => {
    const h = await setup({ ttlSeconds });
    const result = await resume(h, 'execute_sql', 'accept', gap);
    expectTerminalResult(
      result,
      'expired',
      `This confirmation expired after ${lifetime}. Call \`execute_sql\` again to get a new confirmation.`
    );
    expectNothingRan(h);
  }
);

// AI-1372. Regression: the expiry handling swallows other verify failures,
// e.g. a wrapper that maps every codec error to `expired`. A tampered token
// that is also past its expiry pins that the MAC check still comes first,
// so an attacker can't turn a forged state into a tool result. Every row
// must stay the SDK's -32602 with nothing run.
test.each([
  { desc: 'a tampered token past its expiry', gap: 601_000, tamper: true },
  { desc: 'a malformed token', gap: 1_000, tamper: false },
])('$desc is still a -32602 error', async ({ gap, tamper }) => {
  const h = await setup();
  h.setNow(T0);
  const state = issued(await h.call('create_branch')).requestState!;
  // Flip significant bits of the MAC's last base64url character; changing
  // only padding bits can leave the decoded MAC unchanged.
  const bad = tamper
    ? state.slice(0, -1) + (state.endsWith('A') ? 'E' : 'A')
    : 'not-a-request-state';
  h.setNow(T0 + gap);
  await expect(
    h.call('create_branch', {
      requestState: bad,
      inputResponses: { confirm_cost: { action: 'accept', content: {} } },
    })
  ).rejects.toMatchObject({
    code: -32602,
    message: 'Invalid or expired requestState',
  });
  expectNothingRan(h);
});

// AI-1372 (ADV-F1). Regression: an expired token resumed with a query that is
// no longer destructive takes the `not_destructive` bypass, which drops the
// expired result and runs the SQL. INSERT is not destructive, so on that
// route the platform call would run.
test.each(['execute_sql', 'apply_migration'] as const)(
  'an expired %s resume with a non-destructive query returns the expired result',
  async (name) => {
    const h = await setup();
    const state = issued(await h.call(name)).requestState;
    h.setNow(T0 + 601_000);
    const result = await h.resumeCall(name, {
      arguments: {
        ...args[name],
        query: 'INSERT INTO "PRIVATE_TABLE" VALUES (1);',
      },
      requestState: state,
      inputResponses: {
        confirm_destructive: { action: 'accept', content: {} },
      },
    });
    expectTerminalResult(
      result as CallToolResult,
      'expired',
      expiredMessage[name]
    );
    expect(validationFacts(h)).toEqual([
      {
        kind: 'resume_validation',
        feature: 'destructive_sql',
        result: 'expired',
      },
    ]);
    expectNothingRan(h);
  }
);

// AI-1372 (ADV-F2). Regression: an expired token resumed by a client without
// form elicitation takes the `capability_missing` route and runs the SQL.
// The token is minted on a form client and resumed on a second client of the
// same key and principal, so the signature and binding are authentic.
test.each(['execute_sql', 'apply_migration'] as const)(
  'an expired %s resume from a client without form elicitation returns the expired result',
  async (name) => {
    const h = await setup({ resumeCapabilities: {} });
    const result = await resume(h, name, 'accept', 601_000);
    expectTerminalResult(result, 'expired', expiredMessage[name]);
    expect(validationFacts(h)).toEqual([
      {
        kind: 'resume_validation',
        feature: 'destructive_sql',
        result: 'expired',
      },
    ]);
    expectNothingRan(h);
  }
);

// AI-1372 (ADV-F2). Regression: an expired token sent with a matching legacy
// `confirm_cost_id` from a client without form elicitation takes the legacy
// route, which accepts the hash and creates the branch.
test('an expired create_branch resume with a matching legacy confirm_cost_id creates no branch', async () => {
  const h = await setup({ resumeCapabilities: {} });
  const state = issued(await h.call('create_branch')).requestState;
  h.setNow(T0 + 601_000);
  const result = await h.resumeCall('create_branch', {
    arguments: {
      ...args.create_branch,
      confirm_cost_id: await hashObject(pricing.getBranchCost()),
    },
    requestState: state,
  });
  expectTerminalResult(
    result as CallToolResult,
    'expired',
    expiredMessage.create_branch
  );
  expectNothingRan(h);
});

// AI-1372 (precedence). Regression: create_project fetches the organization
// and cost before inspecting the state, and run_notebook fetches and checks
// the notebook first. Either one then returns its own error (read failure,
// changed notebook) instead of the expired message.
test('an expired create_project resume returns the expired result even when platform reads fail', async () => {
  const h = await setup();
  const state = issued(await h.call('create_project')).requestState;
  h.failReads();
  h.setNow(T0 + 601_000);
  const result = await h.resumeCall('create_project', {
    requestState: state,
    inputResponses: { confirm_cost: { action: 'accept', content: {} } },
  });
  expectTerminalResult(
    result as CallToolResult,
    'expired',
    expiredMessage.create_project
  );
  expect(validationFacts(h)).toEqual([
    { kind: 'resume_validation', feature: 'cost', result: 'expired' },
  ]);
  expectNothingRan(h);
});

test('an expired run_notebook resume returns the expired result even when the notebook changed', async () => {
  const h = await setup();
  const state = issued(await h.call('run_notebook')).requestState;
  h.setNotebook({ ...notebook, updated_at: '2026-02-01T00:00:00.000Z' });
  h.setNow(T0 + 601_000);
  const result = await h.resumeCall('run_notebook', {
    requestState: state,
    inputResponses: { confirm_run: { action: 'accept', content: {} } },
  });
  expectTerminalResult(
    result as CallToolResult,
    'expired',
    expiredMessage.run_notebook
  );
  expect(validationFacts(h)).toEqual([
    { kind: 'resume_validation', feature: 'notebook', result: 'expired' },
  ]);
  expectNothingRan(h);
});

// AI-1372 (bind). Regression: the expiry wrapper swallows the codec's bind
// failure, turning a state minted for another principal into a tool result.
// The SDK checks bind after expiry, so only an unexpired state reaches it.
// Same key and binding format as the server; only the principal differs.
test('an unexpired state minted for another principal is still a -32602 error', async () => {
  const h = await setup();
  const first = issued(await h.call('create_branch'));
  const codec = createRequestStateCodec({
    key: KEY,
    bind: (ctx) => `${ctx.mcpReq.method}:PRIVATE_OTHER_PRINCIPAL`,
  });
  const foreign = await codec.mint(payload(first.requestState), {
    mcpReq: { method: 'tools/call' },
  } as ServerContext);
  h.setNow(T0 + 1_000);
  await expect(
    h.call('create_branch', {
      requestState: foreign,
      inputResponses: { confirm_cost: { action: 'accept', content: {} } },
    })
  ).rejects.toMatchObject({
    code: -32602,
    message: 'Invalid or expired requestState',
  });
  expectNothingRan(h);
});
