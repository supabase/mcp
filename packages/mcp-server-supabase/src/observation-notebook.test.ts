import {
  isInputRequiredResult,
  type CallToolResult,
  type ClientCapabilities,
} from '@modelcontextprotocol/client';
import { afterEach, expect, test, vi } from 'vitest';
import {
  assertAttempt,
  form,
  issued,
} from '../test/observation-test-helpers.js';
import { callModernTool, createServerHarness } from '../test/server-harness.js';
import type {
  ObservationContext,
  ObservationEnd,
  ObservationFact,
  RequestObserver,
} from './index.js';
import type {
  NotebookCell,
  NotebookWithContent,
  SupabasePlatform,
} from './platform/types.js';

const harness = createServerHarness();
const projectId = 'PRIVATE_PROJECT';
const notebookId = 'PRIVATE_NOTEBOOK';
const updatedAt = '2026-01-01T00:00:00.000Z';
const writeCell: NotebookCell = {
  id: 'write',
  type: 'database',
  sql: 'INSERT INTO PRIVATE_SQL_TABLE VALUES (1)',
  row_limit: 10,
};
const logCell: NotebookCell = {
  id: 'logs',
  type: 'log',
  sql: 'SELECT PRIVATE_LOG_CONTENT FROM logs',
  time_range: { type: 'relative', unit: 'hour', amount: 1 },
};
const notebook: NotebookWithContent = {
  id: notebookId,
  name: 'PRIVATE_NOTEBOOK_NAME',
  description: null,
  favorite: false,
  inserted_at: updatedAt,
  updated_at: updatedAt,
  owner: null,
  updated_by: null,
  content: { schema_version: 1, cells: [writeCell, logCell] },
};
const runArgs = {
  project_id: projectId,
  notebook_id: notebookId,
  expected_updated_at: updatedAt,
};
const started = {
  kind: 'operation',
  feature: 'notebook',
  disposition: 'started',
};
const returned = {
  kind: 'operation',
  feature: 'notebook',
  disposition: 'returned',
  durationMs: expect.any(Number),
};
const eligible = {
  kind: 'confirmation_decision',
  feature: 'notebook',
  route: 'inline',
  reason: 'eligible',
};
function required(reason: 'initial' | 'missing_response' | 'changed_quote') {
  return { kind: 'input_required', feature: 'notebook', mode: 'form', reason };
}
// Timing fields (`elapsed_ms`, `instant`) are pinned in
// confirmation-instant-cancel.test.ts; these flow tests match only the action.
function response(action: 'accept' | 'decline' | 'cancel') {
  return expect.objectContaining({
    kind: 'input_response',
    feature: 'notebook',
    action,
  });
}
function validation(
  result: 'valid' | 'missing_response' | 'changed_quote' | 'arguments_mismatch'
) {
  return { kind: 'resume_validation', feature: 'notebook', result };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.close();
});

async function setup({
  cells = [writeCell, logCell],
  capabilities = form,
  readOnly = false,
  configured = true,
}: {
  cells?: NotebookCell[];
  capabilities?: ClientCapabilities;
  readOnly?: boolean;
  configured?: boolean;
} = {}) {
  const saved: NotebookWithContent = {
    ...notebook,
    content: { schema_version: 1, cells: [...cells] },
  };
  const getNotebook = vi.fn(async () => saved);
  const executeSql = vi.fn(async () => []);
  const queryLogs = vi.fn(async () => ({ result: [{ PRIVATE_LOG_ROW: 2 }] }));
  const platform = {
    notebooks: {
      getNotebook,
      listNotebooks: vi.fn(async () => []),
    },
    database: {
      executeSql,
      applyMigration: vi.fn(async () => {}),
      listMigrations: vi.fn(async () => []),
    },
    debugging: {
      queryLogs,
      getLogs: vi.fn(async () => []),
      getSecurityAdvisors: vi.fn(async () => []),
      getPerformanceAdvisors: vi.fn(async () => []),
    },
  } satisfies SupabasePlatform;
  const attempts: Array<{
    context: ObservationContext;
    facts: ObservationFact[];
    ends: ObservationEnd[];
  }> = [];
  const observer: RequestObserver = (context) => {
    if (context.method !== 'tools/call') return undefined;
    const attempt: (typeof attempts)[number] = {
      context,
      facts: [],
      ends: [],
    };
    attempts.push(attempt);
    return {
      record: (fact) => {
        attempt.facts.push(fact);
      },
      end: (end) => {
        attempt.ends.push(end);
      },
    };
  };
  const { client } = await harness.setupModern({
    platform,
    features: ['notebooks'],
    readOnly,
    clientCapabilities: capabilities,
    elicitation: {
      requestState: { key: 'a'.repeat(32), principal: 'PRIVATE_PRINCIPAL' },
      confirmation: { enabledTools: configured ? ['run_notebook'] : [] },
    },
    observer,
  });
  attempts.length = 0;
  function run(extra: Partial<Parameters<typeof callModernTool>[1]> = {}) {
    return callModernTool(client, {
      name: 'run_notebook',
      arguments: runArgs,
      ...extra,
    });
  }
  return { attempts, saved, executeSql, queryLogs, run };
}

test('initial and missing-response reissue each records only its own confirmation facts', async () => {
  const h = await setup();
  const first = issued(await h.run());
  issued(await h.run({ requestState: first.requestState }));
  expect(h.attempts).toHaveLength(2);
  assertAttempt(
    h.attempts[0],
    'run_notebook',
    [eligible, required('initial')],
    'input_required'
  );
  assertAttempt(
    h.attempts[1],
    'run_notebook',
    [eligible, validation('missing_response'), required('missing_response')],
    'input_required'
  );
  expect(JSON.stringify(h.attempts)).not.toMatch(/PRIVATE_(SQL|LOG)/);
  expect(h.executeSql).not.toHaveBeenCalled();
  expect(h.queryLogs).not.toHaveBeenCalled();
});

test.each([
  ['accept', 'completed'],
  ['decline', 'declined'],
  ['cancel', 'cancelled'],
] as const)(
  '%s records its response and runs cells only on accept',
  async (action, outcome) => {
    const h = await setup();
    const first = issued(await h.run());
    const result = await h.run({
      requestState: first.requestState,
      inputResponses: {
        confirm_run: action === 'accept' ? { action, content: {} } : { action },
      },
    });
    expect(isInputRequiredResult(result)).toBe(false);
    expect((result as CallToolResult).isError).not.toBe(true);
    expect(h.attempts).toHaveLength(2);
    assertAttempt(
      h.attempts[1],
      'run_notebook',
      [
        eligible,
        response(action),
        ...(action === 'accept'
          ? [validation('valid'), started, returned]
          : []),
      ],
      outcome
    );
    expect(h.executeSql).toHaveBeenCalledTimes(action === 'accept' ? 1 : 0);
    expect(h.queryLogs).toHaveBeenCalledTimes(action === 'accept' ? 1 : 0);
  }
);

test('accept of changed query cells reissues without starting a run', async () => {
  const h = await setup();
  const first = issued(await h.run());
  h.saved.content.cells = [
    { ...writeCell, sql: 'DELETE FROM PRIVATE_CHANGED_SQL' },
    logCell,
  ];
  issued(
    await h.run({
      requestState: first.requestState,
      inputResponses: { confirm_run: { action: 'accept', content: {} } },
    })
  );
  expect(h.attempts).toHaveLength(2);
  assertAttempt(
    h.attempts[1],
    'run_notebook',
    [
      eligible,
      response('accept'),
      validation('changed_quote'),
      required('changed_quote'),
    ],
    'input_required'
  );
  expect(h.executeSql).not.toHaveBeenCalled();
  expect(h.queryLogs).not.toHaveBeenCalled();
});

test('accept for a different notebook is rejected before operation starts', async () => {
  const h = await setup();
  const first = issued(await h.run());
  const result = await h.run({
    arguments: { ...runArgs, notebook_id: 'PRIVATE_OTHER_NOTEBOOK' },
    requestState: first.requestState,
    inputResponses: { confirm_run: { action: 'accept', content: {} } },
  });
  expect((result as CallToolResult).isError).toBe(true);
  expect(h.attempts).toHaveLength(2);
  assertAttempt(
    h.attempts[1],
    'run_notebook',
    [eligible, validation('arguments_mismatch')],
    'tool_error'
  );
  expect(h.executeSql).not.toHaveBeenCalled();
  expect(h.queryLogs).not.toHaveBeenCalled();
});

test('mutating notebook without form capability records a block and no operation', async () => {
  const h = await setup({ capabilities: {} });
  const result = await h.run();
  expect((result as CallToolResult).isError).toBe(true);
  expect(h.attempts).toHaveLength(1);
  assertAttempt(
    h.attempts[0],
    'run_notebook',
    [
      {
        kind: 'confirmation_decision',
        feature: 'notebook',
        route: 'blocked',
        reason: 'capability_missing',
      },
    ],
    'tool_error'
  );
  expect(h.executeSql).not.toHaveBeenCalled();
  expect(h.queryLogs).not.toHaveBeenCalled();
});

test.each([
  { configured: true, readOnly: false, reason: 'not_mutating' },
  { configured: false, readOnly: false, reason: 'not_configured' },
  { configured: true, readOnly: true, reason: 'read_only' },
] as const)(
  'non-mutating multi-cell run records one operation ($reason)',
  async ({ configured, readOnly, reason }) => {
    const h = await setup({
      configured,
      readOnly,
      cells: [
        { id: 'intro', type: 'markdown', text: 'PRIVATE_NOTEBOOK_CONTENT' },
        { ...writeCell, sql: 'SELECT PRIVATE_SQL_CONTENT' },
        logCell,
      ],
    });
    const result = await h.run();
    expect(isInputRequiredResult(result)).toBe(false);
    expect((result as CallToolResult).isError).not.toBe(true);
    expect(h.executeSql).toHaveBeenCalledOnce();
    expect(h.queryLogs).toHaveBeenCalledOnce();
    expect(h.attempts).toHaveLength(1);
    assertAttempt(
      h.attempts[0],
      'run_notebook',
      [
        {
          kind: 'confirmation_decision',
          feature: 'notebook',
          route: 'bypass',
          reason,
        },
        started,
        returned,
      ],
      'completed'
    );
    expect(JSON.stringify(h.attempts)).not.toMatch(
      /PRIVATE_(SQL|LOG|NOTEBOOK_CONTENT|ROW)/
    );
  }
);

test('a caught cell failure still returns one notebook operation result', async () => {
  const h = await setup({
    cells: [{ ...writeCell, sql: 'SELECT PRIVATE_SQL_CONTENT' }, logCell],
  });
  h.executeSql.mockRejectedValueOnce(new Error('PRIVATE_CELL_ERROR'));
  const result = await h.run();
  expect(isInputRequiredResult(result)).toBe(false);
  expect((result as CallToolResult).isError).not.toBe(true);
  expect(JSON.stringify(result)).toContain('PRIVATE_CELL_ERROR');
  expect(h.queryLogs).toHaveBeenCalledOnce();
  expect(h.attempts).toHaveLength(1);
  assertAttempt(
    h.attempts[0],
    'run_notebook',
    [
      {
        kind: 'confirmation_decision',
        feature: 'notebook',
        route: 'bypass',
        reason: 'not_mutating',
      },
      started,
      returned,
    ],
    'completed'
  );
  expect(JSON.stringify(h.attempts)).not.toContain('PRIVATE_CELL_ERROR');
});
