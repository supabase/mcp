import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  isInputRequiredResult,
  type CallToolResult,
  type ClientCapabilities,
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
import type { ElicitationState } from './tools/confirmation.js';
import { getDatabaseTools } from './tools/database-operation-tools.js';
import * as classifier from './tools/destructive-sql.js';

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
const projectId = 'PRIVATE_PROJECT';

async function setup(
  options: {
    configured?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    capabilities?: ClientCapabilities;
    legacy?: boolean;
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
          : { enabledTools: options.disabled ? [] : tools },
    },
  });
  function args(name: SqlTool) {
    return {
      project_id: projectId,
      query,
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

  test.each([
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
  ] as const)(
    'rejects changed $change without consuming accept',
    async ({ mismatch, changedArgs }) => {
      const h = await setup();
      const other = name === 'execute_sql' ? 'apply_migration' : 'execute_sql';
      const first = issued(
        await h.call(mismatch === 'tool_mismatch' ? other : name)
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

  test.each([
    { action: 'decline', fails: false },
    { action: 'cancel', fails: false },
    { action: 'decline', fails: true },
  ] as const)(
    'discards staged $action when classification changes (fails=$fails)',
    async ({ action, fails }) => {
      const h = await setup();
      const first = issued(await h.call(name));
      vi.spyOn(classifier, 'isDestructiveSql').mockImplementation(() => {
        if (fails) throw new Error('PRIVATE_CLASSIFIER_ERROR');
        return false;
      });
      const result = await h.call(name, {
        requestState: first.requestState,
        inputResponses: { confirm_destructive: { action } },
      });
      if (fails) {
        expect((result as CallToolResult).isError).toBe(true);
        expect(JSON.stringify(result)).toContain('PRIVATE_CLASSIFIER_ERROR');
        assertAttempt(h.attempts[1], name, [], 'tool_error');
        expect(h.operation(name)).not.toHaveBeenCalled();
      } else {
        expect((result as CallToolResult).isError).not.toBe(true);
        assertAttempt(
          h.attempts[1],
          name,
          [
            decision('bypass', 'not_destructive'),
            started,
            finished('returned'),
          ],
          'completed'
        );
        expect(h.operation(name)).toHaveBeenCalledOnce();
      }
    }
  );
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
