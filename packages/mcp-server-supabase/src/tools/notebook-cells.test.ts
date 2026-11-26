import { describe, expect, test } from 'vitest';
import {
  applyRowLimit,
  getLogCellRows,
  resolveLogCellWindow,
} from './notebook-cells.js';

describe('applyRowLimit', () => {
  test.each([
    ['select * from users', 'select * from users limit 10;'],
    ['select * from users;', 'select * from users limit 10;'],
    ['  select *\nfrom users\n', 'select *\nfrom users limit 10;'],
    ['SELECT id FROM users', 'SELECT id FROM users limit 10;'],
    // Semicolons inside literals and quoted bodies are not statement breaks.
    ["select 'a;b' as s", "select 'a;b' as s limit 10;"],
    ['select $$a;b$$ as body;', 'select $$a;b$$ as body limit 10;'],
    [
      'select $fn$ x; y $fn$ as tagged',
      'select $fn$ x; y $fn$ as tagged limit 10;',
    ],
    ['select "a;b" from t', 'select "a;b" from t limit 10;'],
    ["select E'it\\'s; ok' as s", "select E'it\\'s; ok' as s limit 10;"],
    // A read-only CTE is a select, as in Studio.
    [
      'with u as (select 1) select * from u',
      'with u as (select 1) select * from u limit 10;',
    ],
    [
      'WITH RECURSIVE t(n) AS (select 1 union all select n + 1 from t) select n from t;',
      'WITH RECURSIVE t(n) AS (select 1 union all select n + 1 from t) select n from t limit 10;',
    ],
    // Write keywords only count in code, not in literals, quoted identifiers
    // or longer words.
    [
      "with u as (select 'insert into t' as s) select * from u",
      "with u as (select 'insert into t' as s) select * from u limit 10;",
    ],
    [
      'with u as (select 1 as "update") select * from u',
      'with u as (select 1 as "update") select * from u limit 10;',
    ],
    [
      'with u as (select $$delete$$ as s) select * from u',
      'with u as (select $$delete$$ as s) select * from u limit 10;',
    ],
    [
      'with u as (select updated_at, deleted from t) select * from u',
      'with u as (select updated_at, deleted from t) select * from u limit 10;',
    ],
  ])('limits %j', (sql, expected) => {
    expect(applyRowLimit(sql, 10)).toBe(expected);
  });

  test.each([
    ['a statement that already has a limit', 'select * from users limit 5'],
    [
      'a statement with limit and offset',
      'select * from users limit 5 offset 10;',
    ],
    ['a fetch first clause', 'select * from users fetch first 5 rows only'],
    ['a fetch next clause', 'select * from users fetch next 5 rows only'],
    ['limit all', 'select * from users limit all;'],
    ['a limit expression', 'select * from users limit (2 + 3);'],
    ['a limit before locking', 'select * from users limit 5 for update;'],
    ['a block comment', 'select * from users limit 5 /* existing limit */'],
    ['a nested limit', 'select * from (select * from users limit 5) as u'],
    ['quoted limit text', "select 'limit' as label"],
    ['multiple statements', 'select 1; select 2;'],
    ['a trailing statement', 'select 1; select 2'],
    ['comments', 'select * from users -- all of them'],
    ['a non-select statement', 'insert into users default values'],
    [
      'a with query that inserts',
      'with u as (select 1) insert into t select * from u',
    ],
    ['a with query that updates', 'with u as (select 1) update t set a = 1'],
    [
      'a with query with a data-modifying CTE',
      'with d as (delete from t returning *) select * from d',
    ],
    [
      'a with query that merges',
      'with u as (select 1 as id) merge into t using u on t.id = u.id when matched then do nothing',
    ],
    [
      'a with query that selects into a table',
      'with u as (select 1) select * into t2 from u',
    ],
    [
      'a with query that locks rows',
      'with u as (select 1) select * from t for update',
    ],
    [
      'a with query with a limit',
      'with u as (select 1) select * from u limit 5',
    ],
    [
      'a with query with comments',
      'with u as (select 1) select * from u -- all',
    ],
    ['an unterminated string', "select 'a;b"],
    ['a statement after a string literal', "select 'a'; select 2"],
  ])('leaves %s unchanged', (_, sql) => {
    expect(applyRowLimit(sql, 10)).toBe(sql);
  });

  test('leaves the SQL unchanged when the limit is 0', () => {
    expect(applyRowLimit('select * from users', 0)).toBe('select * from users');
  });
});

describe('resolveLogCellWindow', () => {
  const now = new Date('2026-03-31T12:00:00.000Z');

  test('passes an absolute range through', () => {
    expect(
      resolveLogCellWindow(
        {
          type: 'absolute',
          start: '2026-03-01T00:00:00.000Z',
          end: '2026-03-02T00:00:00.000Z',
        },
        now
      )
    ).toEqual({
      iso_timestamp_start: '2026-03-01T00:00:00.000Z',
      iso_timestamp_end: '2026-03-02T00:00:00.000Z',
    });
  });

  test.each([
    ['minute', 30, '2026-03-31T11:30:00.000Z'],
    ['hour', 6, '2026-03-31T06:00:00.000Z'],
    ['day', 2, '2026-03-29T12:00:00.000Z'],
    ['week', 1, '2026-03-24T12:00:00.000Z'],
    ['month', 1, '2026-02-28T12:00:00.000Z'],
    ['year', 1, '2025-03-31T12:00:00.000Z'],
  ] as const)(
    'resolves the last %s %d relative to now',
    (unit, amount, start) => {
      expect(
        resolveLogCellWindow({ type: 'relative', unit, amount }, now)
      ).toEqual({
        iso_timestamp_start: start,
        iso_timestamp_end: now.toISOString(),
      });
    }
  );
});

describe('getLogCellRows', () => {
  test.each([
    { error: 'Unknown column', message: 'Unknown column' },
    {
      error: { message: 'Unknown column', code: 47 },
      message: 'Unknown column',
    },
    {
      error: {
        errors: [{ message: 'Unknown column' }, { message: 'At line 1' }],
      },
      message: 'Unknown column\nAt line 1',
    },
    {
      error: { code: 47, detail: 'Unknown column' },
      message: '{"code":47,"detail":"Unknown column"}',
    },
  ])('preserves log error diagnostics: $message', ({ error, message }) => {
    expect(() => getLogCellRows({ result: [], error })).toThrow(message);
  });

  test('unwraps rows from the API envelope', () => {
    const rows = [{ event_message: 'Recovered' }];
    expect(getLogCellRows({ result: rows, error: null })).toBe(rows);
    expect(getLogCellRows(rows)).toBe(rows);
  });
});
