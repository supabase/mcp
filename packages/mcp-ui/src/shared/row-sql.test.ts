import { describe, expect, it } from 'vitest';
import { quoteLiteral, selectRowSql, updateRowSql } from './row-sql';
import type { RowColumn, RowTable } from './row-values';

const column = (name: string, format = 'text'): RowColumn => ({
  name,
  format,
  data_type: format.startsWith('_') ? 'ARRAY' : format,
  nullable: true,
  default_value: null,
  identity: false,
  generated: false,
  updatable: true,
  enums: [],
});

const table: RowTable = {
  schema: 'public',
  name: 'my "items"',
  primary_keys: ['id'],
  editable: true,
  columns: [
    column('id', 'int8'),
    column('note'),
    column('settings', 'jsonb'),
    column('tags', '_text'),
  ],
};

describe('row SQL', () => {
  it('quotes names and values so no value can end the statement', () => {
    expect(
      updateRowSql(
        table,
        { id: '1' },
        { note: "it's done\\'; drop table x; --" }
      )
    ).toBe(
      `update "public"."my ""items""" set "note" = E'it''s done\\\\''; drop table x; --' where "id" = E'1' returning *;`
    );
  });

  it('escapes backslashes whatever standard_conforming_strings is', () => {
    expect(quoteLiteral('C:\\path\\')).toBe("E'C:\\\\path\\\\'");
  });

  it('writes JSON as text and arrays as Postgres array literals', () => {
    expect(
      updateRowSql(
        table,
        { id: 1 },
        { settings: { a: "b'c" }, tags: ['x', null, 'y"z'], note: null }
      )
    ).toBe(
      `update "public"."my ""items""" set "settings" = E'{"a":"b''c"}', "tags" = E'{"x",NULL,"y\\\\"z"}', "note" = NULL where "id" = E'1' returning *;`
    );
  });

  it('reads the row back by its key', () => {
    expect(selectRowSql(table, { id: 7 })).toBe(
      `select * from "public"."my ""items""" where "id" = E'7' limit 1;`
    );
  });
});
