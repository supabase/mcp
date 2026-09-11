import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod/v4';
import type { ObservationFact, RequestObserver } from './observation.js';
import { type Tool, tool } from './server.js';
import { action, capture, handlers } from './observation-test-helpers.js';

const decline: ObservationFact = {
  kind: 'input_response',
  feature: 'cost',
  action: 'decline',
};
const failure = new Error('PRIVATE_ERROR_SENTINEL');

afterEach(() => vi.restoreAllMocks());

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
