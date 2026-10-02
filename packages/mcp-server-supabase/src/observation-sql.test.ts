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
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { z } from 'zod/v4';
import { callModernTool, createServerHarness } from '../test/server-harness.js';
import type {
  ObservationContext,
  ObservationEnd,
  ObservationFact,
  RequestObserver,
} from './index.js';
import type { SupabasePlatform } from './platform/types.js';
import type { ElicitationState } from './tools/confirmation.js';
import { getDatabaseTools } from './tools/database-operation-tools.js';
import * as classifier from './tools/destructive-sql.js';

const tools = ['execute_sql', 'apply_migration'] as const;
type SqlTool = (typeof tools)[number];
type Attempt = {
  context: ObservationContext;
  facts: ObservationFact[];
  ends: ObservationEnd[];
};
const harness = createServerHarness();
const query = 'DROP TABLE "PRIVATE_TABLE"; -- PRIVATE_SQL';
const projectId = 'PRIVATE_PROJECT';
const form: ClientCapabilities = { elicitation: { form: {} } };
const feature = 'destructive_sql' as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.close();
});

async function setup(
  options: {
    configured?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    capabilities?: ClientCapabilities;
    legacy?: boolean;
    observer?: RequestObserver;
    unobserved?: boolean;
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
  const attempts: Attempt[] = [];
  const observer: RequestObserver = (context) => {
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
  };
  const { client } = await (options.legacy
    ? harness.setup
    : harness.setupModern)({
    platform,
    features: ['database'],
    readOnly: options.readOnly,
    clientCapabilities: options.capabilities ?? form,
    elicitation: {
      requestState: { key: 'a'.repeat(32), principal: 'PRIVATE_PRINCIPAL' },
      confirmation:
        options.configured === false
          ? undefined
          : { enabledTools: options.disabled ? [] : tools },
    },
    ...(options.unobserved ? {} : { observer: options.observer ?? observer }),
  });
  attempts.length = 0;
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

function issued(result: CallToolResult | InputRequiredResult) {
  expect(isInputRequiredResult(result)).toBe(true);
  if (!isInputRequiredResult(result))
    throw new Error('expected input_required');
  return result;
}
function decision(
  route: Extract<ObservationFact, { kind: 'confirmation_decision' }>['route'],
  reason: Extract<ObservationFact, { kind: 'confirmation_decision' }>['reason']
): ObservationFact {
  return { kind: 'confirmation_decision', feature, route, reason };
}
function required(reason: 'initial' | 'missing_response'): ObservationFact {
  return { kind: 'input_required', feature, mode: 'form', reason };
}
function response(action: 'accept' | 'decline' | 'cancel'): ObservationFact {
  return { kind: 'input_response', feature, action };
}
function validation(
  result: Extract<ObservationFact, { kind: 'resume_validation' }>['result']
): ObservationFact {
  return { kind: 'resume_validation', feature, result };
}
const started: ObservationFact = {
  kind: 'operation',
  feature,
  disposition: 'started',
};
function finished(disposition: 'returned' | 'threw') {
  return {
    kind: 'operation',
    feature,
    disposition,
    durationMs: expect.any(Number),
  };
}
function assertAttempt(
  attempt: Attempt | undefined,
  tool: SqlTool,
  facts: unknown[],
  result: ObservationEnd['result']
) {
  expect(attempt).toEqual({
    context: { method: 'tools/call', tool },
    facts,
    ends: [{ result, durationMs: expect.any(Number) }],
  });
  for (const event of [...attempt!.facts, ...attempt!.ends]) {
    if ('durationMs' in event) {
      expect(Number.isFinite(event.durationMs)).toBe(true);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
  }
  expect(JSON.stringify(attempt)).not.toContain('PRIVATE_');
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
    expect(JSON.stringify(h.attempts)).not.toContain(first.requestState);
  });

  test.each(['accept', 'decline', 'cancel'] as const)(
    'records only honored %s and actual execution',
    async (action) => {
      const h = await setup();
      const first = issued(await h.call(name));
      const classify = vi.spyOn(classifier, 'isDestructiveSql');
      if (action === 'accept')
        classify.mockImplementation(() => {
          throw new Error('must not classify an accepted resume');
        });
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
      expect(classify).toHaveBeenCalledTimes(accepted ? 0 : 1);
      expect(h.operation(name)).toHaveBeenCalledTimes(accepted ? 1 : 0);
      if (accepted) {
        expect(h.operation(name)).toHaveBeenCalledWith(
          projectId,
          name === 'execute_sql'
            ? { query, read_only: undefined }
            : { query, name: 'PRIVATE_MIGRATION' }
        );
      }
    }
  );

  test.each(['tool_mismatch', 'arguments_mismatch'] as const)(
    'rejects truthful %s without consuming accept',
    async (mismatch) => {
      const h = await setup();
      const other = name === 'execute_sql' ? 'apply_migration' : 'execute_sql';
      const first = issued(
        await h.call(mismatch === 'tool_mismatch' ? other : name)
      );
      const result = await h.call(name, {
        requestState: first.requestState,
        arguments: {
          ...h.args(name),
          ...(mismatch === 'arguments_mismatch'
            ? { query: `${query}\nDROP TABLE "PRIVATE_OTHER";` }
            : {}),
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

  test.each(['decline', 'cancel'] as const)(
    'discards ignored %s when classification changes to non-destructive',
    async (action) => {
      const h = await setup();
      const first = issued(await h.call(name));
      const classify = vi
        .spyOn(classifier, 'isDestructiveSql')
        .mockReturnValue(false);
      const result = await h.call(name, {
        requestState: first.requestState,
        inputResponses: { confirm_destructive: { action } },
      });
      expect((result as CallToolResult).isError).not.toBe(true);
      assertAttempt(
        h.attempts[1],
        name,
        [decision('bypass', 'not_destructive'), started, finished('returned')],
        'completed'
      );
      expect(classify).toHaveBeenCalledOnce();
      expect(classify).toHaveBeenCalledWith(query);
      expect(h.operation(name)).toHaveBeenCalledOnce();
    }
  );

  test('classifier failure does not consume a staged decline or run SQL', async () => {
    const h = await setup();
    const first = issued(await h.call(name));
    vi.spyOn(classifier, 'isDestructiveSql').mockImplementation(() => {
      throw new Error('PRIVATE_CLASSIFIER_ERROR');
    });
    const result = await h.call(name, {
      requestState: first.requestState,
      inputResponses: { confirm_destructive: { action: 'decline' } },
    });
    expect((result as CallToolResult).isError).toBe(true);
    assertAttempt(h.attempts[1], name, [], 'tool_error');
    expect(h.operation(name)).not.toHaveBeenCalled();
  });

  test.each([
    { configured: false, reason: 'not_configured' },
    { disabled: true, reason: 'not_configured' },
    { capabilities: {}, reason: 'capability_missing' },
    { legacy: true, configured: false, reason: 'not_configured' },
  ] as const)(
    'observes allowed bypass $reason ($legacy/$disabled)',
    async (options) => {
      const h = await setup(options);
      const classify = vi.spyOn(classifier, 'isDestructiveSql');
      const result = await h.call(name);
      expect((result as CallToolResult).isError).not.toBe(true);
      assertAttempt(
        h.attempts[0],
        name,
        [decision('bypass', options.reason), started, finished('returned')],
        'completed'
      );
      expect(classify).not.toHaveBeenCalled();
      expect(h.operation(name)).toHaveBeenCalledOnce();
    }
  );

  test('records an initial non-destructive route and preserves the SQL', async () => {
    const h = await setup();
    const safeQuery = 'SELECT 1 AS "PRIVATE_RESULT";';
    const result = await h.call(name, {
      arguments: { ...h.args(name), query: safeQuery },
    });
    expect((result as CallToolResult).isError).not.toBe(true);
    assertAttempt(
      h.attempts[0],
      name,
      [decision('bypass', 'not_destructive'), started, finished('returned')],
      'completed'
    );
    expect(h.operation(name)).toHaveBeenCalledWith(
      projectId,
      name === 'execute_sql'
        ? { query: safeQuery, read_only: undefined }
        : { query: safeQuery, name: 'PRIVATE_MIGRATION' }
    );
  });

  test('read-only policy takes precedence over confirmation and classification', async () => {
    const h = await setup({ readOnly: true });
    const classify = vi.spyOn(classifier, 'isDestructiveSql');
    const result = await h.call(name);
    const blocked = name === 'apply_migration';
    expect((result as CallToolResult).isError === true).toBe(blocked);
    assertAttempt(
      h.attempts[0],
      name,
      [
        decision(blocked ? 'blocked' : 'bypass', 'read_only'),
        ...(blocked ? [] : [started, finished('returned')]),
      ],
      blocked ? 'tool_error' : 'completed'
    );
    expect(classify).not.toHaveBeenCalled();
    if (blocked) expect(h.applyMigration).not.toHaveBeenCalled();
    else
      expect(h.executeSql).toHaveBeenCalledWith(projectId, {
        query,
        read_only: true,
      });
  });

  test('records a backend failure after accepted input without leaking its payload', async () => {
    const h = await setup();
    const first = issued(await h.call(name));
    h.operation(name).mockRejectedValueOnce(new Error('PRIVATE_BACKEND_ERROR'));
    const result = await h.call(name, {
      requestState: first.requestState,
      inputResponses: accept,
    });
    expect((result as CallToolResult).isError).toBe(true);
    expect(JSON.stringify(result)).toContain('PRIVATE_BACKEND_ERROR');
    assertAttempt(
      h.attempts[1],
      name,
      [
        decision('inline', 'eligible'),
        response('accept'),
        validation('valid'),
        started,
        finished('threw'),
      ],
      'tool_error'
    );
    expect(JSON.stringify(h.attempts)).not.toContain(first.requestState);
  });

  test.each(['omitted', 'inactive'] as const)(
    '%s observer preserves confirmation and execution',
    async (mode) => {
      const h = await setup({
        unobserved: mode === 'omitted',
        observer: mode === 'inactive' ? () => undefined : undefined,
      });
      const clock =
        mode === 'omitted' ? vi.spyOn(performance, 'now') : undefined;
      const first = issued(await h.call(name));
      const result = await h.call(name, {
        requestState: first.requestState,
        inputResponses: accept,
      });
      expect((result as CallToolResult).isError).not.toBe(true);
      expect(h.operation(name)).toHaveBeenCalledOnce();
      if (clock) expect(clock).not.toHaveBeenCalled();
      expect(h.attempts).toEqual([]);
    }
  );

  test('throwing record and rejecting end preserve confirmation and backend outcomes', async () => {
    const h = await setup({
      observer: () => ({
        record() {
          throw new Error('PRIVATE_OBSERVER_ERROR');
        },
        end() {
          return Promise.reject(new Error('PRIVATE_OBSERVER_REJECTION'));
        },
      }),
    });
    const first = issued(await h.call(name));
    const result = await h.call(name, {
      requestState: first.requestState,
      inputResponses: accept,
    });
    expect((result as CallToolResult).isError).not.toBe(true);
    h.operation(name).mockRejectedValueOnce(new Error('PRIVATE_BACKEND_ERROR'));
    const failure = await h.call(name, {
      requestState: first.requestState,
      inputResponses: accept,
    });
    expect((failure as CallToolResult).isError).toBe(true);
    expect(JSON.stringify(failure)).toContain('PRIVATE_BACKEND_ERROR');
    expect(h.operation(name)).toHaveBeenCalledTimes(2);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
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
    expect(codec.mint).toHaveBeenCalledOnce();
    expect(facts).toEqual([decision('inline', 'eligible')]);
    expect(database.executeSql).not.toHaveBeenCalled();
    expect(database.applyMigration).not.toHaveBeenCalled();
  }
);
