import { afterEach, describe, expect, test, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { z } from 'zod/v4';
import type {
  RequestObserver,
  ToolClassification,
  ToolObservation,
} from './observation.js';
import { tool } from './server.js';
import {
  action,
  capture,
  handlers,
  type TestFact,
  type TestTool,
} from './observation-test-helpers.js';

const fact: TestFact = { event: 'finished' };
const failure = new Error('PRIVATE_ERROR_SENTINEL');

afterEach(() => vi.restoreAllMocks());

describe('registered handler observations', () => {
  test('all six scopes include shaping, bound context, and exclude end sink latency', async () => {
    const seen = capture();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const observer: RequestObserver<never, TestFact> = (context) => {
      now += 2;
      const sink = seen.observer(context)!;
      return {
        record: sink.record,
        end(end) {
          sink.end(end);
          now += 100;
        },
      };
    };
    const run = handlers({
      observer,
      toolClassification: {
        buckets: [],
        classify() {
          now += 4;
          return 'other';
        },
      },
      tools: {
        private_tool_name: action(async () => ({
          toJSON() {
            now += 3;
            return { ok: true };
          },
        })),
      },
      resources: [
        {
          uri: 'test://private',
          name: 'PRIVATE_NAME',
          async read() {
            return { uri: 'test://private', text: 'PRIVATE_RESULT' };
          },
        },
        {
          uriTemplate: 'test://{id}',
          name: 'PRIVATE_TEMPLATE',
          async read() {
            return [];
          },
        },
      ],
    });
    await run('tools/list');
    await run('resources/list');
    await run('resources/templates/list');
    await run('resources/read', { uri: 'test://private' });
    await run('tools/call', { name: 'private_tool_name' });
    await run('resources/read', { uri: 'test://123' });
    expect(seen.scopes.map(({ context, ends }) => ({ context, ends }))).toEqual(
      [
        ...[
          'tools/list',
          'resources/list',
          'resources/templates/list',
          'resources/read',
        ].map((method) => ({
          context: { method },
          ends: [{ result: 'completed', durationMs: 2 }],
        })),
        {
          context: { method: 'tools/call', tool: 'other' },
          ends: [{ result: 'completed', durationMs: 9 }],
        },
        {
          context: { method: 'resources/read' },
          ends: [{ result: 'completed', durationMs: 2 }],
        },
      ]
    );
    expect(JSON.stringify(seen.scopes)).not.toContain('PRIVATE');
    expect(JSON.stringify(seen.scopes)).not.toContain('private_tool_name');
  });

  test.each(['omitted', 'undefined'] as const)(
    '%s observer avoids fact construction; omitted observer avoids observation work',
    async (mode) => {
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      let constructed = 0;
      const classify = vi.fn(() => 'other' as const);
      const buckets = vi.fn(() => []);
      const run = handlers({
        observer: mode === 'undefined' ? () => undefined : undefined,
        toolClassification: {
          get buckets() {
            return buckets();
          },
          classify,
        },
        tools: {
          task: action(async (_args, _ctx, observation) => {
            observation?.record((constructed++, fact));
            return { ok: true };
          }),
        },
        resources: [
          {
            uri: 'test://a',
            name: 'a',
            async read() {
              return [];
            },
          },
        ],
      });
      await run('tools/call', { name: 'task' });
      await run('tools/list');
      await run('resources/list');
      await run('resources/templates/list');
      await run('resources/read', { uri: 'test://a' });
      expect(constructed).toBe(0);
      if (mode === 'omitted') {
        expect(clock).not.toHaveBeenCalled();
        expect(classify).not.toHaveBeenCalled();
        expect(buckets).not.toHaveBeenCalled();
      }
    }
  );

  test.each([
    { outcome: 'completed', value: { ok: true }, result: 'completed' },
    { outcome: 'declined', value: { ok: true }, result: 'declined' },
    { outcome: 'cancelled', value: { content: [] }, result: 'cancelled' },
    {
      outcome: 'declined',
      value: { resultType: 'input_required' },
      result: 'input_required',
    },
    {
      outcome: 'cancelled',
      value: { content: [], isError: true },
      result: 'tool_error',
    },
    {
      outcome: 'declined',
      value: { resultType: 'input_required', isError: true },
      result: 'tool_error',
    },
  ] as const)(
    'terminal $result takes precedence after explicit $outcome',
    async (row) => {
      const seen = capture();
      vi.spyOn(performance, 'now').mockReturnValue(0);
      const run = handlers({
        observer: seen.observer,
        tools: {
          task: action(async (_args, _ctx, observation) => {
            observation?.setOutcome('declined');
            observation?.setOutcome(row.outcome);
            observation?.record(fact);
            // Malformed combinations exercise package outcomes before SDK validation.
            return row.value as never;
          }),
        },
      });
      await run('tools/call', { name: 'task' });
      expect(seen.scopes[0]!.ends).toEqual([
        { result: row.result, durationMs: 0 },
      ]);
    }
  );

  test.each([
    'getTools',
    'execute',
    'serialization',
    'error-serialization',
  ] as const)(
    'starts before %s failure and closes once with error precedence',
    async (stage) => {
      const seen = capture();
      const callback = vi.fn();
      let scopesAtProvider: number | undefined;
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const execute = vi.fn<TestTool['execute']>(
        async (_args, _ctx, observation) => {
          observation?.setOutcome('declined');
          observation?.record(fact);
          if (stage === 'execute') throw failure;
          if (stage === 'serialization') return cyclic;
          if (stage === 'error-serialization') throw { message: 1n };
          return {};
        }
      );
      const tools = {
        task: tool({
          description: 'test',
          parameters: z.object({ required: z.string() }),
          outputSchema: z.looseObject({}),
          execute,
        }),
      };
      const run = handlers({
        observer: seen.observer,
        onToolCall: callback,
        tools: () => {
          scopesAtProvider = seen.scopes.length;
          if (stage === 'getTools') throw failure;
          return tools;
        },
      });
      const request = run('tools/call', {
        name: 'task',
        arguments: { required: 'PRIVATE_ARGUMENT' },
      });
      if (stage === 'error-serialization')
        await expect(request).rejects.toBeInstanceOf(TypeError);
      else expect(await request).toMatchObject({ isError: true });
      expect(scopesAtProvider).toBe(1);
      expect(seen.scopes.map((scope) => scope.context)).toEqual([
        { method: 'tools/call', tool: 'other' },
      ]);
      expect(seen.scopes[0]!.ends).toEqual([
        {
          result:
            stage === 'error-serialization' ? 'handler_error' : 'tool_error',
          durationMs: expect.any(Number),
        },
      ]);
      expect(callback).toHaveBeenCalledTimes(stage === 'getTools' ? 0 : 1);
      expect(JSON.stringify(seen.scopes)).not.toContain('PRIVATE');
    }
  );

  test.each([
    { method: 'tools/list', stage: 'provider' },
    { method: 'resources/list', stage: 'provider' },
    { method: 'resources/templates/list', stage: 'provider' },
    { method: 'resources/read', stage: 'provider' },
    { method: 'resources/read', stage: 'error-serialization' },
  ] as const)(
    '$method $stage records its existing failure behavior without manufacturing success',
    async ({ method, stage }) => {
      const seen = capture();
      const run = handlers({
        observer: seen.observer,
        tools: () => {
          throw failure;
        },
        resources: () => {
          if (stage === 'error-serialization') throw { message: 1n };
          throw failure;
        },
      });
      const result = run(method, { uri: 'test://a' });
      if (stage === 'error-serialization')
        await expect(result).rejects.toBeInstanceOf(TypeError);
      else if (method === 'resources/read')
        expect(await result).toMatchObject({ isError: true });
      else await expect(result).rejects.toBe(failure);
      expect(seen.scopes[0]!.ends).toEqual([
        {
          result:
            method === 'resources/read' && stage !== 'error-serialization'
              ? 'tool_error'
              : 'handler_error',
          durationMs: expect.any(Number),
        },
      ]);
    }
  );

  test('reverse completion, replay and late handles do not cross scopes', async () => {
    const seen = capture();
    const pending: {
      finish: () => void;
      observation: ToolObservation<TestFact> | undefined;
    }[] = [];
    // Node 20 is supported and does not provide Promise.withResolvers.
    const entries = Array.from({ length: 3 }, () => {
      let signal!: () => void;
      const entered = new Promise<void>((resolve) => {
        signal = resolve;
      });
      return { entered, signal };
    });
    const run = handlers({
      observer: seen.observer,
      tools: {
        task: action(async (_args, _ctx, observation) => {
          await new Promise<void>((resolve) => {
            const index = pending.length;
            pending.push({ finish: resolve, observation });
            entries[index]!.signal();
          });
          return { ok: true };
        }),
      },
    });
    const first = run('tools/call', { name: 'task' });
    await entries[0]!.entered;
    const second = run('tools/call', { name: 'task' });
    await entries[1]!.entered;
    pending[1]!.observation?.setOutcome('cancelled');
    pending[1]!.observation?.record({ event: 'cancelled' });
    pending[1]!.finish();
    await second;
    pending[0]!.observation?.setOutcome('declined');
    pending[0]!.observation?.record(fact);
    pending[0]!.finish();
    await first;
    pending[1]!.observation?.record(fact);
    pending[1]!.observation?.setOutcome('declined');
    const replay = run('tools/call', { name: 'task' });
    await entries[2]!.entered;
    pending[2]!.finish();
    await replay;
    expect(
      seen.scopes.map((scope) => scope.ends.map((end) => end.result))
    ).toEqual([['declined'], ['cancelled'], ['completed']]);
    expect(seen.scopes.map((scope) => scope.facts)).toEqual([
      [fact],
      [{ event: 'cancelled' }],
      [],
    ]);
  });

  test.each([
    'throw',
    'undeclared',
    'invalid',
    'resolved',
    'rejected',
  ] as const)(
    'classifier %s falls back without changing the call',
    async (mode) => {
      const seen = capture<'task'>();
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const classify = (): unknown => {
        if (mode === 'throw') throw failure;
        if (mode === 'undeclared') return 'PRIVATE_TOOL';
        if (mode === 'invalid') return 42;
        if (mode === 'resolved') return Promise.resolve('task');
        return Promise.reject(failure);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const run = handlers({
          observer: seen.observer,
          toolClassification: {
            buckets: ['task'],
            // Deliberately exercise runtime returns outside the synchronous contract.
            // @ts-expect-error Runtime classifier returns unknown.
            classify,
          },
          tools: { PRIVATE_TOOL: action(async () => ({ ok: true })) },
        });
        expect(await run('tools/call', { name: 'PRIVATE_TOOL' })).toEqual({
          content: [{ type: 'text', text: '{"ok":true}' }],
        });
        await setImmediate();
        expect(seen.scopes[0]!.context).toEqual({
          method: 'tools/call',
          tool: 'other',
        });
        expect(seen.scopes[0]!.ends).toEqual([
          { result: 'completed', durationMs: expect.any(Number) },
        ]);
        expect(unhandled).toEqual([]);
        expect(log).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    }
  );

  test.each<unknown>([
    { buckets: ['task', 1], classify: () => 'task' },
    { buckets: new Set(['task']), classify: () => 'task' },
    Object.defineProperty({}, 'buckets', {
      get() {
        throw failure;
      },
    }),
  ])(
    'invalid classification configuration falls back to other',
    async (configuration) => {
      const seen = capture<'task'>();
      const run = handlers({
        observer: seen.observer,
        // JS consumers can supply malformed configuration.
        // @ts-expect-error Invalid runtime configuration.
        toolClassification: configuration,
        tools: { task: action(async () => ({ ok: true })) },
      });
      expect(await run('tools/call', { name: 'task' })).toEqual({
        content: [{ type: 'text', text: '{"ok":true}' }],
      });
      expect(seen.scopes[0]!.context).toEqual({
        method: 'tools/call',
        tool: 'other',
      });
    }
  );

  test('classification uses the requested tool name and snapshots declared buckets at creation', async () => {
    type Bucket = 'task' | 'later';
    const buckets: Bucket[] = ['task'];
    let selected: Bucket = 'task';
    const configuration: ToolClassification<Bucket> = {
      buckets,
      classify: (name) => (name === 'task' ? selected : 'other'),
    };
    const seen = capture<Bucket>();
    const run = handlers({
      observer: seen.observer,
      toolClassification: configuration,
      tools: async () => ({ task: action(async () => ({ ok: true })) }),
    });
    buckets.splice(0, 1, 'later');
    for (const next of ['task', 'later'] as const) {
      selected = next;
      expect(await run('tools/call', { name: 'task' })).toEqual({
        content: [{ type: 'text', text: '{"ok":true}' }],
      });
    }
    expect(seen.scopes.map(({ context }) => context)).toEqual([
      { method: 'tools/call', tool: 'task' },
      { method: 'tools/call', tool: 'other' },
    ]);
  });

  test('facts are opaque and invalid outcomes cannot replace a valid outcome', async () => {
    const seen = capture();
    const opaque = new Proxy(fact, {
      get() {
        throw failure;
      },
    });
    const run = handlers({
      observer: seen.observer,
      tools: {
        task: action(async (_args, _ctx, observation) => {
          expect(observation).not.toHaveProperty('end');
          observation?.record(opaque);
          observation?.setOutcome('cancelled');
          // @ts-expect-error JS consumers can supply invalid outcomes.
          observation?.setOutcome('input_required');
          return { ok: true };
        }),
      },
    });
    expect(await run('tools/call', { name: 'task' })).toEqual({
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
    expect(seen.scopes[0]!.facts[0]).toBe(opaque);
    expect(seen.scopes[0]!.ends[0]!.result).toBe('cancelled');
  });
});
