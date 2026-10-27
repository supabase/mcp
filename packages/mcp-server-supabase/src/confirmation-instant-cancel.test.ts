import {
  isInputRequiredResult,
  type CallToolResult,
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
  createBranch: unknown;
  setNow(value: number): void;
  /** Advance the clock by `ms` on every platform read from now on. */
  delayReads(ms: number): void;
  call(
    name: Tool,
    extra?: { requestState?: string; inputResponses?: InputResponses }
  ): Promise<CallToolResult | InputRequiredResult>;
};

async function setup(): Promise<Harness> {
  const fake = fakePlatform();
  let now = T0;
  let readDelay = 0;
  // Platform reads advance the mocked clock so a test can model a resume
  // whose server-side work takes time.
  function slowRead<A extends unknown[], R>(read: (...a: A) => R) {
    return (...a: A) => {
      now += readDelay;
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
      getNotebook: slowRead(async () => notebook),
      listNotebooks: vi.fn(async () => []),
    },
  } satisfies SupabasePlatform;
  const { client, attempts } = await setupObservation({
    platform,
    features: ['account', 'branching', 'database', 'notebooks'],
    elicitation: {
      requestState: { key: KEY, principal: PRINCIPAL },
      confirmation: { enabledTools: [...tools] },
    },
  });
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    attempts,
    operations: [
      platform.database.executeSql,
      platform.database.applyMigration,
      fake.createProject,
      fake.createBranch,
    ],
    createBranch: fake.createBranch,
    setNow(value) {
      now = value;
    },
    delayReads(ms) {
      readDelay = ms;
    },
    call: (name, extra = {}) =>
      callModernTool(client, { name, arguments: args[name], ...extra }),
  };
}

/** Decoded signed payload (`p`) of a requestState envelope. */
function payload(state: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(state!.split('.')[1]!, 'base64url').toString())
    .p;
}

/** Issue at T0, then resume with `action` at T0 + gap. */
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
  const result = await h.call(name, {
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
