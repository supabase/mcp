import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RequestObservation, RequestObserver } from './observation.js';
import { action, handlers, type TestFact } from './observation-test-helpers.js';

const fact: TestFact = { event: 'started' };
const failure = new Error('PRIVATE_ERROR_SENTINEL');

afterEach(() => vi.restoreAllMocks());

describe('observer noninterference', () => {
  test.each([
    'factory',
    'record',
    'end',
    'pending',
    'then-getter',
    'record-getter',
    'end-getter',
    'factory-then-getter',
  ] as const)(
    '%s failure silently preserves business returns and onToolCall success and error details',
    async (mode) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const events: string[] = [];
      const callback = vi.fn<(details: unknown) => void>(() => {
        events.push('callback');
      });
      const observer: RequestObserver<never, TestFact> = () => {
        if (mode === 'factory') throw failure;
        if (mode === 'factory-then-getter')
          return Object.defineProperty({}, 'then', {
            get() {
              throw failure;
            },
          }) as RequestObservation<TestFact>;
        const sink = {
          record() {
            events.push('record');
            if (mode === 'record') throw failure;
            if (mode === 'pending') return new Promise<void>(() => {});
            if (mode === 'then-getter')
              return Object.defineProperty({}, 'then', {
                get() {
                  throw failure;
                },
              });
          },
          end() {
            events.push('end');
            if (mode === 'end') throw failure;
            if (mode === 'pending') return new Promise<void>(() => {});
            if (mode === 'then-getter')
              return Object.defineProperty({}, 'then', {
                get() {
                  throw failure;
                },
              });
          },
        };
        if (mode === 'record-getter' || mode === 'end-getter') {
          Object.defineProperty(
            sink,
            mode === 'record-getter' ? 'record' : 'end',
            {
              get() {
                throw failure;
              },
            }
          );
        }
        // JS consumers can return malformed thenables from sink methods.
        return sink as unknown as RequestObservation<TestFact>;
      };
      const run = handlers({
        observer,
        onToolCall: callback,
        tools: {
          good: action(async (_args, _ctx, observation) => {
            observation?.record(fact);
            events.push('execute');
            return { privateResult: 'unchanged' };
          }),
          bad: action(async (_args, _ctx, observation) => {
            observation?.record(fact);
            events.push('execute');
            throw failure;
          }),
        },
      });
      expect(await run('tools/call', { name: 'good' })).toEqual({
        content: [{ type: 'text', text: '{"privateResult":"unchanged"}' }],
      });
      expect(await run('tools/call', { name: 'bad' })).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: '{"error":{"name":"Error","message":"PRIVATE_ERROR_SENTINEL"}}',
          },
        ],
      });
      const disabled = mode === 'factory' || mode === 'factory-then-getter';
      expect(events.filter((event) => event === 'record')).toEqual(
        disabled || mode === 'record-getter' ? [] : ['record', 'record']
      );
      expect(events.filter((event) => event === 'end')).toEqual(
        disabled || mode === 'end-getter' ? [] : ['end', 'end']
      );
      expect(events.filter((event) => event === 'execute')).toEqual([
        'execute',
        'execute',
      ]);
      expect(callback.mock.calls).toEqual([
        [
          expect.objectContaining({
            success: true,
            data: { privateResult: 'unchanged' },
          }),
        ],
        [expect.objectContaining({ success: false, error: failure })],
      ]);
      await setImmediate();
      expect(log).not.toHaveBeenCalled();
    }
  );
});

test.each([
  {
    kind: 'native promise with hostile own attachment getters',
    stage: 'factory',
  },
  {
    kind: 'native promise with hostile own attachment getters',
    stage: 'record',
  },
  { kind: 'native promise with hostile own attachment getters', stage: 'end' },
  {
    kind: 'thenable delegating to a rejected native promise',
    stage: 'factory',
  },
  { kind: 'thenable delegating to a rejected native promise', stage: 'record' },
  { kind: 'thenable delegating to a rejected native promise', stage: 'end' },
] as const)(
  'a rejected $kind from $stage is silently consumed without changing the handler result',
  async ({ kind, stage }) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    function rejected() {
      const promise = Promise.reject(failure);
      if (kind === 'thenable delegating to a rejected native promise') {
        return { then: promise.then.bind(promise) };
      }
      Object.defineProperties(promise, {
        catch: {
          get() {
            throw failure;
          },
        },
        then: {
          get() {
            throw failure;
          },
        },
      });
      return promise;
    }
    const observer: RequestObserver<never, TestFact> = () => {
      // Unsupported async factory deliberately returned by a JS consumer.
      if (stage === 'factory')
        return rejected() as unknown as RequestObservation<TestFact>;
      return {
        record() {
          if (stage === 'record') return rejected();
        },
        end() {
          if (stage === 'end') return rejected();
        },
      } as unknown as RequestObservation<TestFact>;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const run = handlers({
        observer,
        tools: {
          test: action(async (_args, _ctx, observation) => {
            observation?.record(fact);
            return { unchanged: true };
          }),
        },
      });
      expect(await run('tools/call', { name: 'test' })).toEqual({
        content: [{ type: 'text', text: '{"unchanged":true}' }],
      });
      // Cross an event-loop boundary so Node can report unhandled rejections.
      await setImmediate();
      expect(unhandled).toEqual([]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }
);
