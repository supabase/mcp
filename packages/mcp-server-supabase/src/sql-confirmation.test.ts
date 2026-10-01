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

describe('regexClassifier', () => {
  test.each([
    ['DROP TABLE films;', 'destructive'],
    ['UPDATE films SET title = null;', 'destructive'],
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
    const fallback = classifierReturning(undefined);

    expect(await withFallback(primary, fallback)('select 1', options())).toBe(
      undefined
    );
    expect(fallback).toHaveBeenCalledOnce();
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

  test('propagates any other primary rejection without the fallback', async () => {
    const error = new Error('worker exited');
    const fallback = classifierReturning(undefined);

    await expect(
      withFallback(async () => {
        throw error;
      }, fallback)('select 1', options())
    ).rejects.toBe(error);
    expect(fallback).not.toHaveBeenCalled();
  });

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

  test('fails closed with the fallback failure when the fallback also fails', async () => {
    const classify = withFallback(
      classifierReturning({ failure: 'unavailable' }),
      classifierReturning({ failure: 'unavailable' })
    );

    expect(await classify('select 1', options())).toEqual({
      failure: 'unavailable',
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
    'rejects a primary result with %s without the fallback',
    async (_label, value) => {
      // A result that broke the type contract, for example over IPC.
      const primary = (async () =>
        value) as unknown as SqlConfirmationClassifier;
      const fallback = classifierReturning(undefined);

      await expect(
        withFallback(primary, fallback)('select 1', options())
      ).rejects.toThrow('classifier returned an invalid result');
      expect(fallback).not.toHaveBeenCalled();
    }
  );
});
