import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  beginObservation,
  type ObservationContext,
  type ObservationEnd,
  type ObservationFact,
  type RequestObservation,
  type RequestObserver,
} from './observation.js';

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
