import { describe, expect, test, vi } from 'vitest';
import {
  regexClassifier,
  SqlClassifierUnavailableError,
  type SqlConfirmationClassification,
  type SqlConfirmationClassifier,
  withFallback,
} from './sql-confirmation.js';

const options = () => ({ signal: new AbortController().signal });

const classifierReturning = (classification: SqlConfirmationClassification) =>
  vi.fn<SqlConfirmationClassifier>(async () => classification);

// regexClassifier is a public export; this pins its mapping directly, without the server.
describe('regexClassifier', () => {
  test.each([
    ['DROP TABLE films;', 'destructive'],
    ['select * from films;', undefined],
  ] as const)('classifies %s as %s', async (sql, expected) => {
    expect(await regexClassifier(sql, options())).toBe(expected);
  });
});

describe('withFallback', () => {
  test('uses the fallback when the primary reports unavailable', async () => {
    const primary = classifierReturning({ failure: 'unavailable' });
    const fallback = classifierReturning('destructive');
    const opts = options();

    expect(await withFallback(primary, fallback)('drop', opts)).toBe(
      'destructive'
    );
    expect(primary).toHaveBeenCalledWith('drop', opts);
    expect(fallback).toHaveBeenCalledWith('drop', opts);
  });

  test('uses the fallback when the primary throws SqlClassifierUnavailableError', async () => {
    const primary = vi.fn<SqlConfirmationClassifier>(async () => {
      throw new SqlClassifierUnavailableError('parser failed to load');
    });
    // A value only the fallback gives: a swallowed throw would resolve with
    // `undefined`.
    const fallback = classifierReturning('do-heuristic');
    const opts = options();

    expect(await withFallback(primary, fallback)('select 1', opts)).toBe(
      'do-heuristic'
    );
    // The fallback gets the caller's own options object, so it sees the same
    // abort signal as the primary.
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback.mock.calls[0]?.[0]).toBe('select 1');
    expect(fallback.mock.calls[0]?.[1]).toBe(opts);
  });

  test('matches an unavailable error from another copy of the module by name', async () => {
    const foreign = new Error('parser failed to load');
    foreign.name = 'SqlClassifierUnavailableError';
    const fallback = classifierReturning('destructive');

    expect(
      await withFallback(async () => {
        throw foreign;
      }, fallback)('drop', options())
    ).toBe('destructive');
  });

  test.each(['timeout', 'crashed', 'oversized'] as const)(
    'passes a primary %s through without the fallback',
    async (failure) => {
      const fallback = classifierReturning(undefined);

      expect(
        await withFallback(classifierReturning({ failure }), fallback)(
          'select 1',
          options()
        )
      ).toEqual({ failure });
      expect(fallback).not.toHaveBeenCalled();
    }
  );

  test.each(['destructive', 'unclassified', undefined] as const)(
    'passes a primary answer %s through without the fallback',
    async (classification) => {
      const fallback = classifierReturning('destructive');

      expect(
        await withFallback(classifierReturning(classification), fallback)(
          'select 1',
          options()
        )
      ).toBe(classification);
      expect(fallback).not.toHaveBeenCalled();
    }
  );

  test.each([
    ['an Error', new Error('worker exited')],
    // A thrown value that is not an Error has no name to match.
    ['a string', 'worker exited'],
  ])(
    'propagates any other primary rejection (%s) without the fallback',
    async (_label, thrown) => {
      const fallback = classifierReturning(undefined);

      await expect(
        withFallback(async () => {
          throw thrown;
        }, fallback)('select 1', options())
      ).rejects.toBe(thrown);
      expect(fallback).not.toHaveBeenCalled();
    }
  );

  test('a custom `on` widens the trigger set', async () => {
    const fallback = classifierReturning('destructive');
    const classify = withFallback(
      classifierReturning({ failure: 'timeout' }),
      fallback,
      { on: ['unavailable', 'timeout'] }
    );

    expect(await classify('drop', options())).toBe('destructive');
    expect(fallback).toHaveBeenCalledOnce();
  });

  test('a custom `on` replaces the default', async () => {
    const fallback = classifierReturning(undefined);
    const classify = withFallback(
      classifierReturning({ failure: 'unavailable' }),
      fallback,
      { on: ['timeout'] }
    );

    expect(await classify('select 1', options())).toEqual({
      failure: 'unavailable',
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  test("returns the fallback's failure as final", async () => {
    const classify = withFallback(
      classifierReturning({ failure: 'unavailable' }),
      classifierReturning({ failure: 'timeout' })
    );

    expect(await classify('select 1', options())).toEqual({
      failure: 'timeout',
    });
  });

  test('propagates a fallback rejection', async () => {
    const error = new SqlClassifierUnavailableError('fallback down too');
    const classify = withFallback(
      classifierReturning({ failure: 'unavailable' }),
      async () => {
        throw error;
      }
    );

    await expect(classify('select 1', options())).rejects.toBe(error);
  });

  test.each([
    ['an unknown kind', { failure: 'exploded' }],
    ['extra keys', { failure: 'unavailable', reason: 'shed' }],
    [
      'an inherited failure',
      Object.assign(Object.create({ failure: 'unavailable' }), { kind: 'x' }),
    ],
    ['no failure', {}],
    ['an array', ['unavailable']],
    ['a non-string kind', { failure: 1 }],
  ])(
    'passes a primary result with %s through unchanged without the fallback',
    async (_label, value) => {
      // A result that broke the type contract, for example over IPC. Only an
      // exact failure can trigger the fallback; judging any other value is
      // the caller's job.
      const primary = (async () =>
        value) as unknown as SqlConfirmationClassifier;
      const fallback = classifierReturning(undefined);

      expect(await withFallback(primary, fallback)('select 1', options())).toBe(
        value
      );
      expect(fallback).not.toHaveBeenCalled();
    }
  );

  // A classifier in the same process can resolve with a live object. Reading
  // it can throw, and that throw is not the primary's rejection: the value is
  // the primary's result, and judging it is the caller's job.
  const throwingTrap = () => {
    throw new Error('trap threw');
  };
  test.each([
    [
      'a getter that throws',
      {
        get failure(): never {
          throw new Error('getter threw');
        },
      },
    ],
    [
      // The error `withFallback` falls back on when the primary rejects with
      // it. Here it comes from reading the result, so it is not a rejection.
      'a getter that throws SqlClassifierUnavailableError',
      {
        get failure(): never {
          throw new SqlClassifierUnavailableError('getter threw');
        },
      },
    ],
    [
      'a Proxy whose traps throw',
      new Proxy(
        { failure: 'unavailable' },
        {
          // `then` stays readable, so a promise can resolve with the proxy.
          get: (_target, key) => (key === 'then' ? undefined : throwingTrap()),
          has: throwingTrap,
          ownKeys: throwingTrap,
          getOwnPropertyDescriptor: throwingTrap,
        }
      ),
    ],
  ])(
    'passes a primary result with %s through unchanged without the fallback',
    async (_label, value) => {
      const primary = (async () =>
        value) as unknown as SqlConfirmationClassifier;
      const fallback = classifierReturning('destructive');

      const result = await withFallback(primary, fallback)(
        'select 1',
        options()
      );

      // Compared by identity outside `expect`, so no matcher reads the value.
      expect(Object.is(result, value)).toBe(true);
      expect(fallback).not.toHaveBeenCalled();
    }
  );
});
