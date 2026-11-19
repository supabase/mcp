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
} from '../test/observation-test-helpers.js';
import type { ObservationFact } from './index.js';
import type { SupabasePlatform } from './platform/types.js';
import {
  regexClassifier,
  type SqlConfirmationClassification,
  type SqlConfirmationClassifier,
} from './sql-confirmation.js';
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
  return { attempts, args, call, operation, executeSql, applyMigration };
}

const accept = { confirm_destructive: { action: 'accept', content: {} } };

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
const classifierFailures: readonly {
  how: string;
  fail: SqlConfirmationClassifier;
}[] = [
  {
    how: 'resolves with a timeout failure',
    fail: async () => ({ failure: 'timeout' }),
  },
  {
    how: 'throws',
    fail: async () => {
      throw new Error('PRIVATE_CLASSIFIER_ERROR');
    },
  },
];

/** The `name` in a failed tool call's `{ "error": { name, message } }` text. */
function errorName(result: CallToolResult) {
  const [content] = result.content;
  if (content?.type !== 'text') throw new Error('expected a text result');
  return (JSON.parse(content.text) as { error?: { name?: unknown } }).error
    ?.name;
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
      [decision('inline', 'eligible'), required('initial')],
      'input_required'
    );
    issued(await h.call(name, { requestState: first.requestState }));
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
        [decision('inline', 'eligible'), validation(mismatch)],
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
        [decision('bypass', 'not_destructive'), started, finished('returned')],
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
    async ({ mismatch, changedArgs, fail }) => {
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
      // classification records nothing.
      assertAttempt(h.attempts[1], name, [], 'tool_error');
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
        decision('inline', 'eligible'),
        validation('missing_response'),
        required('missing_response'),
      ],
      'input_required'
    );
  });
});

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
    expect(facts).toEqual([decision('inline', 'eligible')]);
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
    const facts: unknown[] = [decision(route, reason)];
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
