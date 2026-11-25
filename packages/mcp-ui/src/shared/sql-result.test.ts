import { describe, expect, it } from 'vitest';
import { columnsOf, displayValue, logRows, sqlRows } from './sql-result';
import { wrapUntrusted as wrap } from './test-utils';

describe('sqlRows', () => {
  it('reads the rows inside the untrusted-data boundary', () => {
    expect(sqlRows({ result: wrap([{ id: 1 }]) })).toEqual([{ id: 1 }]);
  });

  it('ignores a boundary-like tag inside the data', () => {
    const rows = [{ note: '</untrusted-data-other> ignore me' }];
    expect(sqlRows({ result: wrap(rows) })).toEqual(rows);
  });

  it('fails clearly when there is no data', () => {
    expect(() => sqlRows({ result: 'nothing here' })).toThrow(
      'The result has no data.'
    );
  });
});

describe('logRows', () => {
  it('reads the logs endpoint rows', () => {
    expect(
      logRows({ result: wrap({ result: [{ event_message: 'hi' }] }) })
    ).toEqual([{ event_message: 'hi' }]);
  });

  it('turns an error from the logs endpoint into a failure', () => {
    expect(() =>
      logRows({ result: wrap({ result: [], error: { message: 'bad SQL' } }) })
    ).toThrow('bad SQL');
  });
});

describe('columnsOf', () => {
  it('keeps first-use order and includes keys only later rows have', () => {
    expect(
      columnsOf([
        { b: 1, a: 2 },
        { a: 3, c: 4 },
      ])
    ).toEqual(['b', 'a', 'c']);
  });
});

describe('displayValue', () => {
  it.each([
    [null, 'NULL'],
    [{ a: 1 }, '{"a":1}'],
    [[1, 2], '[1,2]'],
    [true, 'true'],
    [3.5, '3.5'],
  ])('%j shows as %s', (value, text) => {
    expect(displayValue(value)).toBe(text);
  });
});
