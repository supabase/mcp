import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  ObservationFact,
  RequestObservation,
  RequestObserver,
} from './observation.js';
import { action, capture, handlers } from './observation-test-helpers.js';

const decline: ObservationFact = {
  kind: 'input_response',
  feature: 'cost',
  action: 'decline',
};
const failure = new Error('PRIVATE_ERROR_SENTINEL');

afterEach(() => vi.restoreAllMocks());

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
