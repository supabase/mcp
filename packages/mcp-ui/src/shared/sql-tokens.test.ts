import { describe, expect, it } from 'vitest';
import { tokenizeSql } from './sql-tokens';

const kinds = (sql: string) =>
  tokenizeSql(sql)
    .filter((token) => token.kind)
    .map((token) => [token.text, token.kind]);

describe('tokenizeSql', () => {
  it('colours keywords, strings, literals, types and operators', () => {
    expect(
      kinds("select id::int8 from users where name = 'Ada' and active = true")
    ).toEqual([
      ['select', 'keyword'],
      ['::', 'operator'],
      ['int8', 'type'],
      ['from', 'keyword'],
      ['where', 'keyword'],
      ['=', 'operator'],
      ["'Ada'", 'string'],
      ['and', 'keyword'],
      ['=', 'operator'],
      ['true', 'literal'],
    ]);
  });

  it('keeps comments and quoted names whole, so keywords inside stay plain', () => {
    expect(kinds('-- select everything\nselect "from" from t')).toEqual([
      ['-- select everything', 'comment'],
      ['select', 'keyword'],
      ['from', 'keyword'],
    ]);
  });

  it('gives back the text it was given, so the highlight lines up with it', () => {
    const sql = "select 1.5e3 /* note */, 'it''s'\n  from t;";
    expect(
      tokenizeSql(sql)
        .map((token) => token.text)
        .join('')
    ).toBe(sql);
  });
});
