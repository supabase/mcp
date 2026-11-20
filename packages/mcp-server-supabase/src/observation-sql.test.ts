import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  isInputRequiredResult,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
} from '@modelcontextprotocol/client';
import type {
  RequestStateCodec,
  ServerContext,
} from '@modelcontextprotocol/server';
import type { Tool } from '@supabase/mcp-utils';
import { describe, expect, test, vi } from 'vitest';
import type { z } from 'zod/v4';
import { callModernTool } from '../test/server-harness.js';
import {
  setup as setupObservation,
  factBuilders,
  issued,
  assertAttempt,
  form,
  classifierOutcomes,
  privateClassifierError,
} from '../test/observation-test-helpers.js';
import type { ObservationFact } from './index.js';
import type { SupabasePlatform } from './platform/types.js';
import {
  regexClassifier,
  type SqlConfirmationClassification,
  type SqlConfirmationClassifier,
  withFallback,
} from './sql-confirmation.js';
import { createSqlClassifyStep } from './tools/classify-sql.js';
import type { ElicitationState } from './tools/confirmation.js';
import { getDatabaseTools } from './tools/database-operation-tools.js';

const tools = ['execute_sql', 'apply_migration'] as const;
type SqlTool = (typeof tools)[number];
const {
  decision,
  required,
  response,
  validation,
  started,
  operationEnd: finished,
  classifierCall: classified,
} = factBuilders('destructive_sql');
const query = 'DROP TABLE "PRIVATE_TABLE"; -- PRIVATE_SQL';
// The regex clears this, so only an injected classifier can flag it.
const clearedQuery = 'SELECT 1 AS "PRIVATE_RESULT";';
const projectId = 'PRIVATE_PROJECT';

async function setup(
  options: {
    configured?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    capabilities?: ClientCapabilities;
    legacy?: boolean;
    classifier?: SqlConfirmationClassifier;
    query?: string;
  } = {}
) {
  const executeSql = vi.fn(async () => []);
  const applyMigration = vi.fn(async () => {});
  const platform = {
    database: {
      executeSql,
      applyMigration,
      listMigrations: vi.fn(async () => []),
    },
  } satisfies SupabasePlatform;
  const { client, attempts } = await setupObservation({
    platform,
    features: ['database'],
    readOnly: options.readOnly,
    capabilities: options.capabilities,
    legacy: options.legacy,
    elicitation: {
      requestState: { key: 'a'.repeat(32), principal: 'PRIVATE_PRINCIPAL' },
      confirmation:
        options.configured === false
          ? undefined
          : {
              enabledTools: options.disabled ? [] : tools,
              ...(options.classifier && { classifier: options.classifier }),
            },
    },
  });
  function args(name: SqlTool) {
    return {
      project_id: projectId,
      query: options.query ?? query,
      ...(name === 'apply_migration' ? { name: 'PRIVATE_MIGRATION' } : {}),
    };
  }
  function call(
    name: SqlTool,
    extra: Partial<Parameters<typeof callModernTool>[1]> = {}
  ) {
    return callModernTool(client, { name, arguments: args(name), ...extra });
  }
  function operation(name: SqlTool) {
    return name === 'execute_sql' ? executeSql : applyMigration;
  }
  return {
    client,
    attempts,
    args,
    call,
    operation,
    executeSql,
    applyMigration,
  };
}

const accept = { confirm_destructive: { action: 'accept', content: {} } };
// What a first call records after its classification fact, and how it ends,
// for each classifier verdict.
const firstCall = {
  clears: {
    after: [
      decision('bypass', 'not_destructive'),
      started,
      finished('returned'),
    ],
    end: 'completed',
  },
  flags: {
    after: [decision('inline', 'eligible'), required('initial')],
    end: 'input_required',
  },
  fails: { after: [], end: 'tool_error' },
} as const;

// Resends whose state does not fit the call: issued for the other tool, or for
// other SQL or another project.
const staleStates = [
  { change: 'tool', mismatch: 'tool_mismatch', changedArgs: {} },
  {
    change: 'query',
    mismatch: 'arguments_mismatch',
    changedArgs: { query: `${query}\nDROP TABLE "PRIVATE_OTHER";` },
  },
  {
    change: 'project_id',
    mismatch: 'arguments_mismatch',
    changedArgs: { project_id: 'PRIVATE_OTHER_PROJECT' },
  },
] as const;

function otherTool(name: SqlTool): SqlTool {
  return name === 'execute_sql' ? 'apply_migration' : 'execute_sql';
}

// The two ways a classifier cannot answer: a failure it resolves with, and a
// throw.
const classifierFailures = [
  {
    how: 'resolves with a timeout failure',
    fail: async () => ({ failure: 'timeout' }),
    result: 'timeout',
  },
  {
    how: 'throws',
    fail: async () => {
      throw new Error('PRIVATE_CLASSIFIER_ERROR');
    },
    result: 'rejected',
  },
] as const satisfies readonly {
  how: string;
  fail: SqlConfirmationClassifier;
  result: string;
}[];

/** The `name` in a failed tool call's `{ "error": { name, message } }` text. */
function errorName(result: CallToolResult) {
  const [content] = result.content;
  if (content?.type !== 'text') throw new Error('expected a text result');
  return (JSON.parse(content.text) as { error?: { name?: unknown } }).error
    ?.name;
}

/** The `message` in a failed tool call's `{ "error": { name, message } }` text. */
function errorMessage(result: CallToolResult | InputRequiredResult) {
  if (isInputRequiredResult(result)) {
    throw new Error('expected a CallToolResult');
  }
  const [content] = result.content;
  if (content?.type !== 'text') throw new Error('expected a text result');
  const message = (
    JSON.parse(content.text) as { error?: { message?: unknown } }
  ).error?.message;
  if (typeof message !== 'string') throw new Error('expected an error message');
  return message;
}

function promptMessage(result: InputRequiredResult) {
  const params = result.inputRequests?.confirm_destructive?.params;
  return params && 'message' in params ? params.message : undefined;
}

describe.each(tools)('%s SQL observations', (name) => {
  test('issues and reissues without executing or consuming a missing response', async () => {
    const h = await setup();
    const first = issued(await h.call(name));
    assertAttempt(
      h.attempts[0],
      name,
      [
        classified('destructive'),
        decision('inline', 'eligible'),
        required('initial'),
      ],
      'input_required'
    );
    issued(await h.call(name, { requestState: first.requestState }));
    assertAttempt(
      h.attempts[1],
      name,
      [
        classified('destructive'),
        decision('inline', 'eligible'),
        validation('missing_response'),
        required('missing_response'),
      ],
      'input_required'
    );
    expect(h.operation(name)).not.toHaveBeenCalled();
  });

  test.each(['accept', 'decline', 'cancel'] as const)(
    'records only honored %s and actual execution',
    async (action) => {
      const h = await setup();
      const first = issued(await h.call(name));
      const result = await h.call(name, {
        requestState: first.requestState,
        inputResponses: {
          confirm_destructive:
            action === 'accept' ? { action, content: {} } : { action },
        },
      });
      expect((result as CallToolResult).isError).not.toBe(true);
      const accepted = action === 'accept';
      assertAttempt(
        h.attempts[1],
        name,
        [
          decision('inline', 'eligible'),
          response(action),
          ...(accepted
            ? [validation('valid'), started, finished('returned')]
            : []),
        ],
        accepted ? 'completed' : action === 'decline' ? 'declined' : 'cancelled'
      );
      expect(h.operation(name)).toHaveBeenCalledTimes(accepted ? 1 : 0);
    }
  );

  test.each(staleStates)(
    'rejects changed $change without consuming accept',
    async ({ mismatch, changedArgs }) => {
      const h = await setup();
      const first = issued(
        await h.call(mismatch === 'tool_mismatch' ? otherTool(name) : name)
      );
      const result = await h.call(name, {
        requestState: first.requestState,
        arguments: {
          ...h.args(name),
          ...changedArgs,
        },
        inputResponses: accept,
      });
      expect((result as CallToolResult).isError).toBe(true);
      assertAttempt(
        h.attempts[1],
        name,
        [
          classified('destructive'),
          decision('inline', 'eligible'),
          validation(mismatch),
        ],
        'tool_error'
      );
      expect(h.operation(name)).not.toHaveBeenCalled();
    }
  );

  // The row above feeds SQL that still flags. State that does not fit the call
  // is only an error for SQL that needs confirmation, so the other two
  // classifier classes get their own rows on the same paths.
  test.each(staleStates)(
    'runs SQL the classifier now clears and ignores the stale state (changed $change)',
    async ({ mismatch, changedArgs }) => {
      let classification: SqlConfirmationClassification = 'destructive';
      const h = await setup({ classifier: async () => classification });
      const first = issued(
        await h.call(mismatch === 'tool_mismatch' ? otherTool(name) : name)
      );
      classification = undefined;
      const sent = { ...h.args(name), ...changedArgs };
      const result = await h.call(name, {
        requestState: first.requestState,
        arguments: sent,
        inputResponses: accept,
      });
      expect(isInputRequiredResult(result)).toBe(false);
      expect((result as CallToolResult).isError).not.toBe(true);
      assertAttempt(
        h.attempts[1],
        name,
        [
          classified('not_destructive'),
          decision('bypass', 'not_destructive'),
          started,
          finished('returned'),
        ],
        'completed'
      );
      expect(h.operation(name)).toHaveBeenCalledOnce();
      expect(h.operation(name)).toHaveBeenCalledWith(
        sent.project_id,
        name === 'execute_sql'
          ? { query: sent.query, read_only: undefined }
          : { query: sent.query, name: 'PRIVATE_MIGRATION' }
      );
    }
  );

  test.each(
    staleStates.flatMap((stale) =>
      classifierFailures.map((failure) => ({ ...stale, ...failure }))
    )
  )(
    'returns the classification error, not the state error, when the classifier $how (changed $change)',
    async ({ mismatch, changedArgs, fail, result: factResult }) => {
      let current: SqlConfirmationClassifier = async () => 'destructive';
      const h = await setup({
        classifier: (sql, options) => current(sql, options),
      });
      const first = issued(
        await h.call(mismatch === 'tool_mismatch' ? otherTool(name) : name)
      );
      current = fail;
      const result = await h.call(name, {
        requestState: first.requestState,
        arguments: { ...h.args(name), ...changedArgs },
        inputResponses: accept,
      });
      expect(isInputRequiredResult(result)).toBe(false);
      expect((result as CallToolResult).isError).toBe(true);
      expect(errorName(result as CallToolResult)).toBe(
        'SqlClassifierCallError'
      );
      expect(JSON.stringify(result)).not.toContain('PRIVATE_CLASSIFIER_ERROR');
      // The state error records a decision and a validation fact. A failed
      // classification records only its own fact.
      assertAttempt(
        h.attempts[1],
        name,
        [classified(factResult)],
        'tool_error'
      );
      expect(JSON.stringify(h.attempts)).not.toContain('PRIVATE_CLASSIFIER');
      expect(h.executeSql).not.toHaveBeenCalled();
      expect(h.applyMigration).not.toHaveBeenCalled();
    }
  );

  // Once asked, only an accept runs the SQL: a decline or cancel stays final
  // whatever the SQL classifies as on the resend.
  test.each([
    { action: 'decline', fails: false },
    { action: 'cancel', fails: false },
    { action: 'decline', fails: true },
  ] as const)(
    'keeps staged $action final when classification changes (fails=$fails)',
    async ({ action, fails }) => {
      const classify = vi.fn<SqlConfirmationClassifier>(
        async () => 'destructive'
      );
      const h = await setup({ classifier: classify, query: clearedQuery });
      const first = issued(await h.call(name));
      classify.mockClear();
      classify.mockImplementation(async () => {
        if (fails) throw new Error('PRIVATE_CLASSIFIER_ERROR');
        return undefined;
      });
      const result = await h.call(name, {
        requestState: first.requestState,
        inputResponses: { confirm_destructive: { action } },
      });
      expect((result as CallToolResult).isError).not.toBe(true);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_CLASSIFIER_ERROR');
      assertAttempt(
        h.attempts[1],
        name,
        [decision('inline', 'eligible'), response(action)],
        action === 'decline' ? 'declined' : 'cancelled'
      );
      expect(h.operation(name)).not.toHaveBeenCalled();
      // Regression: the resend classifies again and swallows the error.
      expect(classify).not.toHaveBeenCalled();
    }
  );

  test('asks again without executing when an unanswered resend no longer classifies as destructive', async () => {
    let classification: SqlConfirmationClassification = 'destructive';
    const h = await setup({
      classifier: async () => classification,
      query: clearedQuery,
    });
    const first = issued(await h.call(name));
    classification = undefined;
    const result = await h.call(name, { requestState: first.requestState });
    expect(h.operation(name)).not.toHaveBeenCalled();
    const again = issued(result);
    expect(again.requestState).toEqual(expect.any(String));
    // The first prompt says the SQL includes destructive operations. That is
    // no longer true, so this prompt can't repeat it.
    expect(promptMessage(again)).toEqual(expect.any(String));
    expect(promptMessage(again)).not.toBe(promptMessage(first));
    assertAttempt(
      h.attempts[1],
      name,
      [
        classified('not_destructive'),
        decision('inline', 'eligible'),
        validation('missing_response'),
        required('missing_response'),
      ],
      'input_required'
    );
  });

  // The SQL is one the regex clears and each classifier's own text is marked
  // PRIVATE_, so only the injected classifier decides and any of it that
  // reaches a fact shows up.
  test.each(classifierOutcomes)(
    'first call records one payload-free $result fact when the classifier $label',
    async ({ classify, result, verdict }) => {
      const h = await setup({ classifier: classify, query: clearedQuery });
      await h.call(name);
      expect(h.attempts).toHaveLength(1);
      assertAttempt(
        h.attempts[0],
        name,
        [classified(result), ...firstCall[verdict].after],
        firstCall[verdict].end
      );
      expect(JSON.stringify(h.attempts)).not.toContain('PRIVATE_');
    }
  );

  // A classifier in this process can resolve with a live object whose
  // `failure` changes between reads: `timeout` for the first reads, then the
  // classifier's own text. Whichever read the fact takes its result from,
  // the result is one of the fixed values. One row per number of valid reads,
  // so no read position can pass that text on. The client's error must be the
  // one for that same result: a step that reads the result once for the fact
  // and again for the message can record one outcome and report the other.
  test.each(
    Array.from({ length: 13 }, (_, validReads) => [
      { validReads, how: 'on its own' },
      { validReads, how: 'through withFallback' },
    ]).flat()
  )(
    'first call records one fixed-result fact that agrees with the client error when the classifier returns a failure whose kind changes after $validReads reads, $how',
    async ({ validReads, how }) => {
      const classify = (async () => {
        let reads = 0;
        return {
          get failure() {
            reads += 1;
            return reads <= validReads ? 'timeout' : 'PRIVATE_FAILURE_KIND';
          },
        };
      }) as unknown as SqlConfirmationClassifier;
      const h = await setup({
        classifier:
          how === 'on its own'
            ? classify
            : withFallback(classify, regexClassifier),
        query: clearedQuery,
      });
      const result = await h.call(name);
      expect(h.attempts).toHaveLength(1);
      assertAttempt(
        h.attempts[0],
        name,
        [
          {
            ...classified('timeout'),
            // Either is right for a result that changes while it is read.
            result: expect.stringMatching(/^(timeout|invalid)$/),
          },
        ],
        'tool_error'
      );
      expect(JSON.stringify(h.attempts)).not.toContain('PRIVATE_');
      expect(h.operation(name)).not.toHaveBeenCalled();
      // With an observer the step reads the result for the fact first, so
      // the text can reach the client from a later read than without one.
      expect(JSON.stringify(result)).not.toContain('PRIVATE_');
      // Keywords only, so a reworded message still passes.
      const fact = h.attempts[0]!.facts.find(
        (recorded) => recorded.kind === 'sql_classifier_call'
      );
      const message = errorMessage(result);
      if (fact?.result === 'timeout') {
        expect(message).toContain('timeout');
      } else {
        expect(message).toContain('invalid result');
        expect(message).not.toContain('timeout');
      }
    }
  );

  // No row for a classifier that now clears: 'asks again without executing
  // when an unanswered resend no longer classifies as destructive' is that
  // test.
  test.each(
    classifierOutcomes.filter((row) => !row.variant && row.verdict !== 'clears')
  )(
    'unanswered resend records one $result fact when the classifier $label',
    async ({ classify, result, verdict }) => {
      let current: SqlConfirmationClassifier = async () => 'destructive';
      const h = await setup({
        classifier: (sql, options) => current(sql, options),
        query: clearedQuery,
      });
      const first = issued(await h.call(name));
      current = classify;
      await h.call(name, { requestState: first.requestState });
      expect(h.attempts).toHaveLength(2);
      assertAttempt(
        h.attempts[1],
        name,
        [
          classified(result),
          ...(verdict === 'fails'
            ? []
            : [
                decision('inline', 'eligible'),
                validation('missing_response'),
                required('missing_response'),
              ]),
        ],
        verdict === 'fails' ? 'tool_error' : 'input_required'
      );
    }
  );

  test.each([
    { settles: 'resolves', throws: false },
    { settles: 'rejects', throws: true },
  ])(
    'records aborted when the request is cancelled before the classifier $settles',
    async ({ throws }) => {
      let classifierSignal: AbortSignal | undefined;
      const h = await setup({
        classifier: async (_sql, { signal }) => {
          classifierSignal = signal;
          // Executor form: the package's lib target predates withResolvers.
          await new Promise((resolve) =>
            signal.addEventListener('abort', resolve, { once: true })
          );
          if (throws) throw privateClassifierError();
          return undefined;
        },
        query: clearedQuery,
      });
      const controller = new AbortController();

      const request = h.client.request(
        {
          method: 'tools/call',
          params: { name, arguments: h.args(name) },
        },
        { allowInputRequired: true, signal: controller.signal }
      );
      await vi.waitFor(() => expect(classifierSignal).toBeDefined());
      expect(classifierSignal?.aborted).toBe(false);
      controller.abort();
      await expect(request).rejects.toThrow();

      await vi.waitFor(() => expect(h.attempts[0]?.ends).toHaveLength(1));
      expect(h.executeSql).not.toHaveBeenCalled();
      expect(h.applyMigration).not.toHaveBeenCalled();
      expect(h.attempts).toHaveLength(1);
      assertAttempt(h.attempts[0], name, [classified('aborted')], 'tool_error');
      expect(JSON.stringify(h.attempts)).not.toContain('PRIVATE_');
    }
  );
});

// One tool is enough: every tool gets its facts from the same classify step.
test.each([
  { settles: 'resolves', result: 'not_destructive', throws: false },
  { settles: 'rejects', result: 'rejected', throws: true },
] as const)(
  'the classification fact times the classifier call when it $settles',
  async ({ result, throws }) => {
    const h = await setup({
      // The classifier takes 250 ms on the controlled clock.
      classifier: async () => {
        vi.advanceTimersByTime(250);
        if (throws) throw privateClassifierError();
        return undefined;
      },
      query: clearedQuery,
    });
    // Only the clocks are faked, so the server's own timers still run.
    vi.useFakeTimers({ toFake: ['performance', 'Date'] });
    await h.call('execute_sql');
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0]!.facts[0]).toEqual({
      ...classified(result),
      durationMs: 250,
    });
  }
);

test.each(tools)(
  '%s failed state mint never records issuance or execution',
  async (name) => {
    const failure = new Error('PRIVATE_MINT_ERROR');
    const facts: ObservationFact[] = [];
    const database = {
      executeSql: vi.fn(async () => []),
      applyMigration: vi.fn(async () => {}),
      listMigrations: vi.fn(async () => []),
    };
    const codec = {
      mint: vi.fn(async () => {
        throw failure;
      }),
    } as unknown as RequestStateCodec<ElicitationState>;
    const ctx = {
      mcpReq: {
        requestState: () => undefined,
        signal: new AbortController().signal,
        envelope: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_CAPABILITIES_META_KEY]: form,
        },
      },
    } as unknown as ServerContext;
    const sqlTools = getDatabaseTools({
      database,
      confirmation: { codec, enabledTools: tools },
      classifySql: createSqlClassifyStep(regexClassifier),
    });
    const sqlTool: Tool<
      z.ZodObject<any>,
      z.ZodObject<any>,
      ObservationFact
    > = sqlTools[name];
    await expect(
      sqlTool.execute(
        sqlTool.parameters.parse({
          project_id: projectId,
          query,
          name: 'PRIVATE_MIGRATION',
        }),
        ctx,
        {
          record: (fact) => {
            facts.push(fact);
          },
          setOutcome: vi.fn(),
        }
      )
    ).rejects.toBe(failure);
    expect(facts).toEqual([
      classified('destructive'),
      decision('inline', 'eligible'),
    ]);
    expect(database.executeSql).not.toHaveBeenCalled();
    expect(database.applyMigration).not.toHaveBeenCalled();
  }
);

test.each([
  // tool, readOnly, configured, formCapable, destructive, route, reason, outcome
  [
    'execute_sql',
    false,
    false,
    false,
    false,
    'bypass',
    'not_configured',
    'completed',
  ],
  [
    'execute_sql',
    false,
    false,
    false,
    true,
    'bypass',
    'not_configured',
    'completed',
  ],
  [
    'execute_sql',
    false,
    false,
    true,
    false,
    'bypass',
    'not_configured',
    'completed',
  ],
  [
    'execute_sql',
    false,
    false,
    true,
    true,
    'bypass',
    'not_configured',
    'completed',
  ],
  [
    'execute_sql',
    false,
    true,
    false,
    false,
    'bypass',
    'capability_missing',
    'completed',
  ],
  [
    'execute_sql',
    false,
    true,
    false,
    true,
    'bypass',
    'capability_missing',
    'completed',
  ],
  [
    'execute_sql',
    false,
    true,
    true,
    false,
    'bypass',
    'not_destructive',
    'completed',
  ],
  [
    'execute_sql',
    false,
    true,
    true,
    true,
    'inline',
    'eligible',
    'input_required',
  ],
  [
    'execute_sql',
    true,
    false,
    false,
    false,
    'bypass',
    'read_only',
    'completed',
  ],
  ['execute_sql', true, false, false, true, 'bypass', 'read_only', 'completed'],
  ['execute_sql', true, false, true, false, 'bypass', 'read_only', 'completed'],
  ['execute_sql', true, false, true, true, 'bypass', 'read_only', 'completed'],
  ['execute_sql', true, true, false, false, 'bypass', 'read_only', 'completed'],
  ['execute_sql', true, true, false, true, 'bypass', 'read_only', 'completed'],
  ['execute_sql', true, true, true, false, 'bypass', 'read_only', 'completed'],
  ['execute_sql', true, true, true, true, 'bypass', 'read_only', 'completed'],
  [
    'apply_migration',
    false,
    false,
    false,
    false,
    'bypass',
    'not_configured',
    'completed',
  ],
  [
    'apply_migration',
    false,
    false,
    false,
    true,
    'bypass',
    'not_configured',
    'completed',
  ],
  [
    'apply_migration',
    false,
    false,
    true,
    false,
    'bypass',
    'not_configured',
    'completed',
  ],
  [
    'apply_migration',
    false,
    false,
    true,
    true,
    'bypass',
    'not_configured',
    'completed',
  ],
  [
    'apply_migration',
    false,
    true,
    false,
    false,
    'bypass',
    'capability_missing',
    'completed',
  ],
  [
    'apply_migration',
    false,
    true,
    false,
    true,
    'bypass',
    'capability_missing',
    'completed',
  ],
  [
    'apply_migration',
    false,
    true,
    true,
    false,
    'bypass',
    'not_destructive',
    'completed',
  ],
  [
    'apply_migration',
    false,
    true,
    true,
    true,
    'inline',
    'eligible',
    'input_required',
  ],
  [
    'apply_migration',
    true,
    false,
    false,
    false,
    'blocked',
    'read_only',
    'tool_error',
  ],
  [
    'apply_migration',
    true,
    false,
    false,
    true,
    'blocked',
    'read_only',
    'tool_error',
  ],
  [
    'apply_migration',
    true,
    false,
    true,
    false,
    'blocked',
    'read_only',
    'tool_error',
  ],
  [
    'apply_migration',
    true,
    false,
    true,
    true,
    'blocked',
    'read_only',
    'tool_error',
  ],
  [
    'apply_migration',
    true,
    true,
    false,
    false,
    'blocked',
    'read_only',
    'tool_error',
  ],
  [
    'apply_migration',
    true,
    true,
    false,
    true,
    'blocked',
    'read_only',
    'tool_error',
  ],
  [
    'apply_migration',
    true,
    true,
    true,
    false,
    'blocked',
    'read_only',
    'tool_error',
  ],
  [
    'apply_migration',
    true,
    true,
    true,
    true,
    'blocked',
    'read_only',
    'tool_error',
  ],
] as const)(
  '%s initial policy: readOnly=%s configured=%s form=%s destructive=%s -> %s/%s/%s',
  async (
    name,
    readOnly,
    configured,
    formCapable,
    destructive,
    route,
    reason,
    outcome
  ) => {
    const h = await setup({
      readOnly,
      disabled: !configured,
      capabilities: formCapable ? form : {},
    });
    const sql = destructive
      ? 'DROP TABLE "PRIVATE_TABLE"; -- PRIVATE_SQL'
      : 'SELECT 1 AS "PRIVATE_RESULT";';
    const result = await h.call(name, {
      arguments: { ...h.args(name), query: sql },
    });
    // Only these two rows get as far as asking the classifier. The SQL is
    // `sql` above, so the built-in regex clears the SELECT and flags the DROP.
    const facts: unknown[] = [
      ...(reason === 'not_destructive'
        ? [classified('not_destructive')]
        : reason === 'eligible'
          ? [classified('destructive')]
          : []),
      decision(route, reason),
    ];
    switch (outcome) {
      case 'completed':
        expect(isInputRequiredResult(result)).toBe(false);
        expect((result as CallToolResult).isError).not.toBe(true);
        facts.push(started, finished('returned'));
        expect(h.operation(name)).toHaveBeenCalledOnce();
        expect(h.operation(name)).toHaveBeenCalledWith(
          projectId,
          name === 'execute_sql'
            ? { query: sql, read_only: readOnly }
            : { query: sql, name: 'PRIVATE_MIGRATION' }
        );
        break;
      case 'input_required':
        issued(result);
        facts.push(required('initial'));
        expect(h.executeSql).not.toHaveBeenCalled();
        expect(h.applyMigration).not.toHaveBeenCalled();
        break;
      case 'tool_error':
        expect(isInputRequiredResult(result)).toBe(false);
        expect((result as CallToolResult).isError).toBe(true);
        expect(h.executeSql).not.toHaveBeenCalled();
        expect(h.applyMigration).not.toHaveBeenCalled();
        break;
    }
    expect(h.attempts).toHaveLength(1);
    assertAttempt(h.attempts[0], name, facts, outcome);
  }
);

// Keep absent confirmation configuration distinct from enabledTools: [].
describe.each(tools)('%s absent confirmation configuration', (name) => {
  test.each([false, true])(
    'completes without confirmation (legacy=%s)',
    async (legacy) => {
      const h = await setup({ configured: false, legacy });
      const result = await h.call(name);
      expect(isInputRequiredResult(result)).toBe(false);
      expect((result as CallToolResult).isError).not.toBe(true);
      expect(h.attempts).toHaveLength(1);
      assertAttempt(
        h.attempts[0],
        name,
        [decision('bypass', 'not_configured'), started, finished('returned')],
        'completed'
      );
      expect(h.operation(name)).toHaveBeenCalledOnce();
    }
  );
});
