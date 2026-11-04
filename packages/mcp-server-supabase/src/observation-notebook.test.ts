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
function completed(
  executed: number,
  skipped: number,
  errored: number,
  budget_exhausted: boolean
) {
  return {
    kind: 'notebook_run',
    outcome: 'completed',
    executed,
    skipped,
    errored,
    budget_exhausted,
  };
}

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
  enabledTools = configured ? ['run_notebook', 'delete_notebook'] : [],
}: {
  cells?: NotebookCell[];
  capabilities?: ClientCapabilities;
  readOnly?: boolean;
  configured?: boolean;
  enabledTools?: ('run_notebook' | 'delete_notebook')[];
} = {}) {
  const saved: NotebookWithContent = {
    ...notebook,
    content: { schema_version: 1, cells: [...cells] },
  };
  const getNotebook = vi.fn(async () => saved);
  const executeSql = vi.fn(
    async (
      ..._args: Parameters<
        NonNullable<SupabasePlatform['database']>['executeSql']
      >
    ) => [] as unknown[]
  );
  const deleteNotebook = vi.fn(async () => {});
  const queryLogs = vi.fn(async () => ({ result: [{ PRIVATE_LOG_ROW: 2 }] }));
  const platform = {
    notebooks: {
      getNotebook,
      listNotebooks: vi.fn(async () => []),
      deleteNotebook,
    },
    database: {
      executeSql: async <T>(
        ...args: Parameters<
          NonNullable<SupabasePlatform['database']>['executeSql']
        >
      ) => (await executeSql(...args)) as T[],
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
      confirmation: { enabledTools },
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
  function del(extra: Partial<Parameters<typeof callModernTool>[1]> = {}) {
    return callModernTool(client, {
      name: 'delete_notebook',
      arguments: { project_id: projectId, notebook_id: notebookId },
      ...extra,
    });
  }
  return { attempts, saved, executeSql, queryLogs, deleteNotebook, run, del };
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
          ? [validation('valid'), started, completed(2, 0, 0, false), returned]
          : []),
      ],
      outcome
    );
    if (action === 'decline') {
      expect(
        h.attempts[1]!.facts.filter((fact) => fact.kind === 'notebook_run')
      ).toEqual([]);
    }
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
        completed(2, 0, 0, false),
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
      completed(2, 0, 1, false),
      returned,
    ],
    'completed'
  );
  expect(JSON.stringify(h.attempts)).not.toContain('PRIVATE_CELL_ERROR');
});

test('a run over 50 query cells records refusal without executing cells', async () => {
  const h = await setup({
    cells: Array.from({ length: 51 }, (_, index) => ({
      ...writeCell,
      id: `query-${index}`,
      sql: `SELECT ${index}`,
    })),
  });
  const result = await h.run();
  expect((result as CallToolResult).isError).toBe(true);
  expect(h.attempts).toHaveLength(1);
  expect(
    h.attempts[0]!.facts.filter((fact) => fact.kind === 'notebook_run')
  ).toEqual([
    { kind: 'notebook_run', outcome: 'refused', reason: 'too_many_cells' },
  ]);
  expect(h.executeSql).not.toHaveBeenCalled();
  expect(h.queryLogs).not.toHaveBeenCalled();
});

test('a completed run counts errored cells and cells skipped after the budget is spent', async () => {
  const h = await setup({
    cells: Array.from({ length: 5 }, (_, index) => ({
      ...writeCell,
      id: `query-${index}`,
      sql: `SELECT ${index}`,
    })),
  });
  // [] uses two bytes; the third executed cell fills the remaining 999,998 bytes.
  h.executeSql
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('PRIVATE_CELL_ERROR'))
    .mockResolvedValueOnce(['x'.repeat(999_994)]);
  const result = await h.run();
  expect(isInputRequiredResult(result)).toBe(false);
  expect((result as CallToolResult).isError).not.toBe(true);
  expect(h.executeSql).toHaveBeenCalledTimes(3);
  expect(h.attempts).toHaveLength(1);
  expect(
    h.attempts[0]!.facts.filter((fact) => fact.kind === 'notebook_run')
  ).toEqual([completed(3, 2, 1, true)]);
});

test('completed notebook_run counts only selected executions and budget skips', async () => {
  const h = await setup({
    cells: Array.from({ length: 5 }, (_, index) => ({
      ...writeCell,
      id: `query-${index}`,
      sql: `SELECT ${index}`,
    })),
  });
  // A JSON array containing one string uses four framing bytes.
  h.executeSql.mockResolvedValueOnce(['x'.repeat(999_996)]);

  const result = await h.run({
    arguments: { ...runArgs, cells: ['query-4', 'query-0', 'query-2'] },
  });

  expect(isInputRequiredResult(result)).toBe(false);
  expect((result as CallToolResult).isError).not.toBe(true);
  expect(h.executeSql).toHaveBeenCalledOnce();
  expect(h.attempts).toHaveLength(1);
  expect(
    h.attempts[0]!.facts.filter((fact) => fact.kind === 'notebook_run')
  ).toEqual([completed(1, 2, 0, true)]);
});

test.each([
  ['accept', 'completed'],
  ['decline', 'declined'],
  ['cancel', 'cancelled'],
] as const)(
  'delete %s records its response and deletes only on accept',
  async (action, outcome) => {
    const h = await setup();
    const first = issued(await h.del());
    const result = await h.del({
      requestState: first.requestState,
      inputResponses: {
        confirm_delete:
          action === 'accept' ? { action, content: {} } : { action },
      },
    });
    expect(isInputRequiredResult(result)).toBe(false);
    expect(h.attempts).toHaveLength(2);
    assertAttempt(
      h.attempts[0],
      'delete_notebook',
      [eligible, required('initial')],
      'input_required'
    );
    assertAttempt(
      h.attempts[1],
      'delete_notebook',
      [
        eligible,
        response(action),
        ...(action === 'accept'
          ? [validation('valid'), started, returned]
          : []),
      ],
      outcome
    );
    expect(h.deleteNotebook).toHaveBeenCalledTimes(action === 'accept' ? 1 : 0);
    expect(JSON.stringify(h.attempts)).not.toContain('PRIVATE_NOTEBOOK_NAME');
  }
);

test('delete without form capability records a block and no operation', async () => {
  const h = await setup({ capabilities: {} });
  const result = await h.del();
  expect((result as CallToolResult).isError).toBe(true);
  assertAttempt(
    h.attempts[0],
    'delete_notebook',
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
  expect(h.deleteNotebook).not.toHaveBeenCalled();
});

test('skipping delete confirmation deletes without a prompt while runs still confirm', async () => {
  const h = await setup({ enabledTools: ['run_notebook'] });
  const deleted = await h.del();
  expect(isInputRequiredResult(deleted)).toBe(false);
  assertAttempt(
    h.attempts[0],
    'delete_notebook',
    [
      {
        kind: 'confirmation_decision',
        feature: 'notebook',
        route: 'bypass',
        reason: 'not_configured',
      },
      started,
      returned,
    ],
    'completed'
  );
  expect(h.deleteNotebook).toHaveBeenCalledOnce();

  issued(await h.run());
  expect(h.executeSql).not.toHaveBeenCalled();
});

test('skipping run confirmation runs mutating cells while deletes still confirm', async () => {
  const h = await setup({ enabledTools: ['delete_notebook'] });
  const ran = await h.run();
  expect(isInputRequiredResult(ran)).toBe(false);
  expect(h.executeSql).toHaveBeenCalledOnce();

  issued(await h.del());
  expect(h.deleteNotebook).not.toHaveBeenCalled();
});
