import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  beginObservation,
  type ObservationContext,
  type ObservationEnd,
  type RequestObservation,
  type RequestObserver,
} from './observation.js';
import type { TestFact } from './observation-test-helpers.js';

const context: ObservationContext = {
  method: 'tools/call',
  tool: 'other',
};
const fact: TestFact = { event: 'finished' };
const completed: ObservationEnd = { result: 'completed', durationMs: 0 };
const failure = new Error('PRIVATE_ERROR_SENTINEL');

afterEach(() => vi.restoreAllMocks());

describe('safe observation scope', () => {
  test('first end closes even when the sink throws; duplicates and late facts are inert', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const record = vi.fn();
    const end = vi.fn(() => {
      throw failure;
    });
    const scope = beginObservation<never, TestFact>(
      () => ({ record, end }),
      context
    )!;
    scope.tool.setOutcome('declined');
    scope.tool.record(fact);
    scope.tool.record(fact);
    expect(scope.outcome()).toBe('declined');
    scope.end('completed');
    scope.end('handler_error');
    scope.tool.setOutcome('completed');
    scope.tool.record({ event: 'late' });
    expect(record.mock.calls).toEqual([[fact], [fact]]);
    expect(end.mock.calls).toEqual([[completed]]);
    expect(scope.outcome()).toBe('declined');
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
      } as unknown as RequestObservation<TestFact>;
      const scope = beginObservation(() => sink, context)!;
      scope.tool.setOutcome('declined');
      scope.tool.record(fact);
      scope.end('completed');
      // Let native promise adoption and its rejection handler run.
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(2);
      expect(scope.outcome()).toBe('declined');
      expect(log).not.toHaveBeenCalled();
    }
  );

  test('throwing sink getters do not prevent terminal action tracking or closing', () => {
    const accesses: string[] = [];
    const sink: RequestObservation<TestFact> = {
      get record(): RequestObservation<TestFact>['record'] {
        accesses.push('record');
        throw failure;
      },
      get end(): RequestObservation<TestFact>['end'] {
        accesses.push('end');
        throw failure;
      },
    };
    const scope = beginObservation(() => sink, context)!;
    scope.tool.setOutcome('declined');
    scope.tool.record(fact);
    scope.end('completed');
    scope.tool.record(fact);
    scope.end('completed');
    expect(accesses).toEqual(['record', 'end']);
    expect(scope.outcome()).toBe('declined');
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
