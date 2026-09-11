import { setImmediate } from 'node:timers/promises';
import { Server, type ServerContext } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod/v4';
import {
  beginObservation,
  type ObservationContext,
  type ObservationEnd,
  type ObservationFact,
  type RequestObservation,
  type RequestObserver,
} from './observation.js';
import {
  createMcpServer,
  type McpServerOptions,
  type Tool,
  tool,
} from './server.js';

const context: ObservationContext = {
  method: 'tools/call',
  tool: 'create_project',
};
const decline: ObservationFact = {
  kind: 'input_response',
  feature: 'cost',
  action: 'decline',
};
const completed: ObservationEnd = { result: 'completed', durationMs: 0 };
const failure = new Error('PRIVATE_ERROR_SENTINEL');

afterEach(() => vi.restoreAllMocks());

function capture() {
  const scopes: {
    context: ObservationContext;
    facts: ObservationFact[];
    ends: ObservationEnd[];
  }[] = [];
  const observer: RequestObserver = (context) => {
    const scope = {
      context,
      facts: [] as ObservationFact[],
      ends: [] as ObservationEnd[],
    };
    scopes.push(scope);
    return {
      record(fact) {
        scope.facts.push(fact);
      },
      end(end) {
        scope.ends.push(end);
      },
    };
  };
  return { observer, scopes };
}

// Exercise the registered package handler, before the SDK's result validator.
// This is needed for deliberately unserializable returns and error serialization.
function handlers(options: Partial<McpServerOptions> = {}) {
  const registration = vi.spyOn(Server.prototype, 'setRequestHandler');
  createMcpServer({ name: 'test', version: '1', ...options });
  // The package uses only the two-argument registration overload.
  type Handler = (
    request: unknown,
    ctx: ServerContext
  ) => unknown | Promise<unknown>;
  const calls = registration.mock.calls as unknown as [string, Handler][];
  const registered = Object.fromEntries(calls);
  registration.mockRestore();
  return async (method: string, params: Record<string, unknown> = {}) => {
    const handler = registered[method];
    if (!handler) throw new Error(`Handler not registered: ${method}`);
    // Each request below supplies the params for its method; SDK validation is
    // tested separately through the real transport in server.test.ts.
    return handler({ method, params }, {} as ServerContext);
  };
}

function action(execute: Tool['execute']) {
  return tool({
    description: 'test',
    parameters: z.object({}),
    outputSchema: z.looseObject({}),
    execute,
  });
}

describe('safe observation scope', () => {
  test('first end closes even when the sink throws; duplicates and late facts are inert', () => {
    const record = vi.fn();
    const end = vi.fn(() => {
      throw failure;
    });
    const scope = beginObservation(() => ({ record, end }), context)!;
    scope.record(decline);
    scope.record(decline);
    expect(scope.consumedTerminal()).toBe('declined');
    scope.end(completed);
    scope.end({ result: 'handler_error', durationMs: 12 });
    scope.record({ kind: 'input_response', feature: 'cost', action: 'accept' });
    expect(record.mock.calls).toEqual([[decline], [decline]]);
    expect(end.mock.calls).toEqual([[completed]]);
    expect(scope.consumedTerminal()).toBe('declined');
  });

  test.each([
    'throw',
    'reject',
    'then-getter',
    'then-throw',
    'pending',
  ] as const)(
    'contains %s from both record and end without waiting or logging',
    async (mode) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      let calls = 0;
      const hostile = () => {
        calls++;
        if (mode === 'throw') throw failure;
        if (mode === 'reject') return Promise.reject(failure);
        if (mode === 'pending') return new Promise<void>(() => {});
        if (mode === 'then-getter')
          return Object.defineProperty({}, 'then', {
            get() {
              throw failure;
            },
          });
        return {
          then() {
            throw failure;
          },
        };
      };
      // Deliberately exercise JS consumers outside the declared return type.
      const sink = {
        record: hostile,
        end: hostile,
      } as unknown as RequestObservation;
      const scope = beginObservation(() => sink, context)!;
      scope.record(decline);
      scope.end(completed);
      // Let native promise adoption and its rejection handler run.
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(2);
      expect(scope.consumedTerminal()).toBe('declined');
      expect(log).not.toHaveBeenCalled();
    }
  );

  test('throwing sink getters do not prevent terminal action tracking or closing', () => {
    const accesses: string[] = [];
    const sink: RequestObservation = {
      get record(): RequestObservation['record'] {
        accesses.push('record');
        throw failure;
      },
      get end(): RequestObservation['end'] {
        accesses.push('end');
        throw failure;
      },
    };
    const scope = beginObservation(() => sink, context)!;
    scope.record(decline);
    scope.end(completed);
    scope.record(decline);
    scope.end(completed);
    expect(accesses).toEqual(['record', 'end']);
    expect(scope.consumedTerminal()).toBe('declined');
  });

  test('factory throws, undefined, promises and throwing then getters disable the scope', async () => {
    const factories = [
      () => {
        throw failure;
      },
      () => undefined,
      () => Promise.reject(failure),
      () => new Promise(() => {}),
      () =>
        Object.defineProperty({}, 'then', {
          get() {
            throw failure;
          },
        }),
    ];
    for (const factory of factories) {
      expect(
        beginObservation(factory as RequestObserver, context)
      ).toBeUndefined();
    }
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('registered handler observations', () => {
  test('all five scopes include shaping, bound context, and exclude end sink latency', async () => {
    const seen = capture();
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const observer: RequestObserver = (context) => {
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
    expect(seen.scopes.map(({ context, ends }) => ({ context, ends }))).toEqual(
      [
        ...[
          'tools/list',
          'resources/list',
          'resources/templates/list',
          'resources/read',
        ].map((method) => ({
          context: { method, tool: 'not_applicable' },
          ends: [{ result: 'completed', durationMs: 2 }],
        })),
        {
          context: { method: 'tools/call', tool: 'other' },
          ends: [{ result: 'completed', durationMs: 5 }],
        },
      ]
    );
    expect(clock).toHaveBeenCalledTimes(10);
    expect(JSON.stringify(seen.scopes)).not.toContain('PRIVATE');
    expect(JSON.stringify(seen.scopes)).not.toContain('private_tool_name');
  });

  test.each(['omitted', 'undefined'] as const)(
    '%s observer avoids recorder, facts and subsequent clocks',
    async (mode) => {
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      let constructed = 0;
      const run = handlers({
        observer: mode === 'undefined' ? () => undefined : undefined,
        tools: {
          create_project: action(async (_args, _ctx, record) => {
            record?.((constructed++, decline));
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
      await run('tools/call', { name: 'create_project' });
      await run('tools/list');
      await run('resources/list');
      await run('resources/templates/list');
      await run('resources/read', { uri: 'test://a' });
      expect(constructed).toBe(0);
      expect(clock).toHaveBeenCalledTimes(mode === 'omitted' ? 0 : 5);
    }
  );

  test.each([
    { action: 'accept', value: { ok: true }, result: 'completed' },
    { action: 'decline', value: { ok: true }, result: 'declined' },
    { action: 'cancel', value: { content: [] }, result: 'cancelled' },
    {
      action: 'decline',
      value: { resultType: 'input_required' },
      result: 'input_required',
    },
    {
      action: 'cancel',
      value: { content: [], isError: true },
      result: 'tool_error',
    },
    {
      action: 'decline',
      value: { resultType: 'input_required', isError: true },
      result: 'tool_error',
    },
  ] as const)(
    'terminal $result takes precedence after consumed $action',
    async (row) => {
      const seen = capture();
      vi.spyOn(performance, 'now').mockReturnValue(0);
      const run = handlers({
        observer: seen.observer,
        tools: {
          create_branch: action(async (_args, _ctx, record) => {
            record?.({
              kind: 'input_response',
              feature: 'cost',
              action: row.action,
            });
            // Malformed combinations deliberately test package shaping, not SDK DTO validation.
            return row.value as never;
          }),
        },
      });
      expect(await run('tools/call', { name: 'create_branch' })).toEqual(
        'content' in row.value || 'resultType' in row.value
          ? row.value
          : { content: [{ type: 'text', text: JSON.stringify(row.value) }] }
      );
      expect(seen.scopes[0]!.ends).toEqual([
        { result: row.result, durationMs: 0 },
      ]);
    }
  );

  test.each([
    'getTools',
    'name',
    'parse',
    'execute',
    'serialization',
    'error-serialization',
  ] as const)(
    'starts before %s failure and closes once with error precedence',
    async (stage) => {
      const seen = capture();
      const callback = vi.fn();
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const execute = vi.fn<Tool['execute']>(async (_args, _ctx, record) => {
        record?.(decline);
        if (stage === 'execute') throw failure;
        if (stage === 'serialization') return cyclic;
        if (stage === 'error-serialization') throw { message: 1n };
        return {};
      });
      const tools = {
        create_project: tool({
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
          expect(seen.scopes.map((scope) => scope.context)).toEqual([
            {
              method: 'tools/call',
              tool: stage === 'name' ? 'other' : 'create_project',
            },
          ]);
          if (stage === 'getTools') throw failure;
          return tools;
        },
      });
      const request = run('tools/call', {
        name: stage === 'name' ? 'missing' : 'create_project',
        arguments: stage === 'parse' ? {} : { required: 'PRIVATE_ARGUMENT' },
      });
      if (stage === 'error-serialization')
        await expect(request).rejects.toBeInstanceOf(TypeError);
      else expect(await request).toMatchObject({ isError: true });
      expect(seen.scopes[0]!.ends).toEqual([
        {
          result:
            stage === 'error-serialization' ? 'handler_error' : 'tool_error',
          durationMs: expect.any(Number),
        },
      ]);
      expect(callback).toHaveBeenCalledTimes(
        ['getTools', 'name', 'parse'].includes(stage) ? 0 : 1
      );
      expect(JSON.stringify(seen.scopes)).not.toContain('PRIVATE');
    }
  );

  test.each([
    'tools/list',
    'resources/list',
    'resources/templates/list',
    'resources/read',
  ] as const)(
    '%s records its existing failure behavior without manufacturing success',
    async (method) => {
      const seen = capture();
      const run = handlers({
        observer: seen.observer,
        tools: () => {
          throw failure;
        },
        resources: () => {
          throw failure;
        },
      });
      const result = run(method, { uri: 'test://a' });
      if (method === 'resources/read')
        expect(await result).toMatchObject({ isError: true });
      else await expect(result).rejects.toBe(failure);
      expect(seen.scopes[0]!.ends).toEqual([
        {
          result: method === 'resources/read' ? 'tool_error' : 'handler_error',
          durationMs: expect.any(Number),
        },
      ]);
    }
  );

  test('reverse completion, replay and late recorders do not cross scopes', async () => {
    const seen = capture();
    const pending: {
      finish: () => void;
      record: ((fact: ObservationFact) => void) | undefined;
    }[] = [];
    // Node 20 is supported and does not provide Promise.withResolvers.
    const run = handlers({
      observer: seen.observer,
      tools: {
        create_project: action(async (_args, _ctx, record) => {
          await new Promise<void>((resolve) => {
            pending.push({ finish: resolve, record });
          });
          return { ok: true };
        }),
      },
    });
    const first = run('tools/call', { name: 'create_project' });
    const second = run('tools/call', { name: 'create_project' });
    // getTools is awaited before each execute.
    await Promise.resolve();
    pending[1]!.record?.({
      kind: 'input_response',
      feature: 'cost',
      action: 'cancel',
    });
    pending[1]!.finish();
    await second;
    pending[0]!.record?.(decline);
    pending[0]!.finish();
    await first;
    pending[1]!.record?.(decline);
    const replay = run('tools/call', { name: 'create_project' });
    await Promise.resolve();
    pending[2]!.finish();
    await replay;
    expect(
      seen.scopes.map((scope) => scope.ends.map((end) => end.result))
    ).toEqual([['declined'], ['cancelled'], ['completed']]);
    expect(seen.scopes.map((scope) => scope.facts)).toEqual([
      [decline],
      [{ kind: 'input_response', feature: 'cost', action: 'cancel' }],
      [],
    ]);
  });
});

describe('observer noninterference', () => {
  test.each(['factory', 'record', 'end', 'pending'] as const)(
    '%s failure preserves callback ordering, business returns and execution errors',
    async (mode) => {
      const order: string[] = [];
      const callback = vi.fn<(details: unknown) => void>(() => {
        order.push('callback');
      });
      const observer: RequestObserver = () => {
        if (mode === 'factory') throw failure;
        return {
          record() {
            order.push('record');
            if (mode === 'record') throw failure;
            if (mode === 'pending') return new Promise<void>(() => {});
          },
          end() {
            order.push('end');
            if (mode === 'end') throw failure;
            if (mode === 'pending') return new Promise<void>(() => {});
          },
        };
      };
      const run = handlers({
        observer,
        onToolCall: callback,
        tools: {
          good: action(async (_args, _ctx, record) => {
            record?.({
              kind: 'operation',
              feature: 'cost',
              disposition: 'started',
            });
            order.push('execute');
            return { privateResult: 'unchanged' };
          }),
          bad: action(async (_args, _ctx, record) => {
            record?.({
              kind: 'operation',
              feature: 'cost',
              disposition: 'started',
            });
            order.push('execute');
            throw failure;
          }),
        },
      });
      expect(await run('tools/call', { name: 'good' })).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ privateResult: 'unchanged' }),
          },
        ],
      });
      expect(await run('tools/call', { name: 'bad' })).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: { name: failure.name, message: failure.message },
            }),
          },
        ],
      });
      expect(order).toEqual(
        mode === 'factory'
          ? ['execute', 'callback', 'execute', 'callback']
          : [
              'record',
              'execute',
              'callback',
              'end',
              'record',
              'execute',
              'callback',
              'end',
            ]
      );
      expect(callback.mock.calls[0]![0]).toMatchObject({
        success: true,
        data: { privateResult: 'unchanged' },
      });
      expect(callback.mock.calls[1]![0]).toMatchObject({
        success: false,
        error: failure,
      });
    }
  );

  test('resources/read error serialization failure ends as handler_error', async () => {
    const seen = capture();
    const run = handlers({
      observer: seen.observer,
      resources: () => {
        throw { message: 1n };
      },
    });
    await expect(
      run('resources/read', { uri: 'test://a' })
    ).rejects.toBeInstanceOf(TypeError);
    expect(seen.scopes[0]!.ends).toEqual([
      { result: 'handler_error', durationMs: expect.any(Number) },
    ]);
  });
});

test.each(['factory', 'record', 'end'] as const)(
  'a rejected native promise with hostile own attachment getters from %s is consumed',
  async (stage) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    const getter = vi.fn(() => {
      throw failure;
    });
    function rejected() {
      const promise = Promise.reject(failure);
      Object.defineProperties(promise, {
        catch: { get: getter },
        then: { get: getter },
      });
      return promise;
    }
    const observer: RequestObserver = () => {
      // Unsupported async factory deliberately returned by a JS consumer.
      if (stage === 'factory')
        return rejected() as unknown as RequestObservation;
      return {
        record() {
          if (stage === 'record') return rejected();
        },
        end() {
          if (stage === 'end') return rejected();
        },
      };
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const run = handlers({
        observer,
        tools: {
          test: action(async (_args, _ctx, record) => {
            record?.(decline);
            return { unchanged: true };
          }),
        },
      });
      expect(await run('tools/call', { name: 'test' })).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ unchanged: true }) }],
      });
      // Cross a real event-loop boundary so Node can report unhandled rejections;
      // no elapsed-time delay is used to guess at completion.
      await setImmediate();
      expect(unhandled).toEqual([]);
      expect(getter).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }
);
