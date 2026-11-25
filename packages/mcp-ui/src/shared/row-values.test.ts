import { describe, expect, it } from 'vitest';
import {
  buildRowValues,
  initialRowDraft,
  isRowWritable,
  parseCellValue,
  type RowColumn,
  type RowTable,
} from './row-values';

const column: RowColumn = {
  name: 'value',
  format: 'text',
  data_type: 'text',
  nullable: true,
  default_value: null,
  identity: false,
  generated: false,
  updatable: true,
  enums: [],
};

const table: RowTable = {
  schema: 'public',
  name: 'items',
  primary_keys: ['id'],
  editable: true,
  columns: [
    { ...column, name: 'id', format: 'int8', nullable: false, identity: true },
    { ...column, name: 'label' },
    { ...column, name: 'count', format: 'int4' },
  ],
};

describe('parseCellValue', () => {
  it('keeps large numbers as strings so int8 and numeric values do not lose precision', () => {
    expect(
      parseCellValue({ ...column, format: 'int8' }, '9007199254740993', false)
    ).toBe('9007199254740993');
  });

  it('distinguishes NULL from empty text, and refuses NULL where the column forbids it', () => {
    expect(parseCellValue(column, '', false)).toBe('');
    expect(parseCellValue(column, '', true)).toBeNull();
    expect(() =>
      parseCellValue({ ...column, nullable: false }, '', true)
    ).toThrow('NULL');
  });

  it('rejects values that do not fit the column type before they reach the database', () => {
    expect(() =>
      parseCellValue({ ...column, format: 'int4' }, '12.3', false)
    ).toThrow('whole number');
    expect(() =>
      parseCellValue({ ...column, format: 'bool' }, 'yes', false)
    ).toThrow('true or false');
    expect(parseCellValue({ ...column, format: 'bool' }, 'false', false)).toBe(
      false
    );
  });

  it('writes JSON and array fields as structured values', () => {
    expect(
      parseCellValue({ ...column, format: 'jsonb' }, '{"a":[true,null]}', false)
    ).toEqual({ a: [true, null] });
    const array = { ...column, format: '_text', data_type: 'ARRAY' };
    expect(parseCellValue(array, '["one",null]', false)).toEqual(['one', null]);
    expect(() => parseCellValue(array, '{}', false)).toThrow('JSON array');
  });
});

describe('buildRowValues', () => {
  const row = { id: 1, label: 'Old', count: 2 };

  it('never updates the primary key or identity columns', () => {
    const draft = initialRowDraft(table, row);
    draft.id = { raw: '2', mode: 'value' };
    draft.label = { raw: 'New', mode: 'value' };
    expect(
      buildRowValues(table, draft, table.columns.slice(0, 2), true)
    ).toEqual({
      label: 'New',
    });
  });

  it('names the column when a field is invalid', () => {
    const draft = initialRowDraft(table, row);
    draft.count = { raw: '1.5', mode: 'value' };
    expect(() =>
      buildRowValues(table, draft, [table.columns[2]!], true)
    ).toThrow('count: Enter a whole number.');
  });
});

describe('isRowWritable', () => {
  it('needs an editable table, a writable connection and a complete key', () => {
    expect(isRowWritable(table, false, { id: 1 })).toBe(true);
    expect(isRowWritable(table, true, { id: 1 })).toBe(false);
    expect(isRowWritable({ ...table, editable: false }, false, { id: 1 })).toBe(
      false
    );
    expect(isRowWritable(table, false, { id: null })).toBe(false);
  });
});
