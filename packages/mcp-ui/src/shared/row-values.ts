/**
 * Row editing rules, ported from `row-values.ts` in the Supabase surfaces:
 * how a column's form text becomes a value, which fields may change, and what
 * an update writes. Updates only: `show_row` opens existing rows.
 */
import { displayValue, type Row } from './sql-result';

/** A column of the row's table (`ShowRowColumn` in mcp-server-supabase). */
export type RowColumn = {
  name: string;
  format: string;
  data_type: string;
  nullable: boolean;
  default_value: string | null;
  identity: boolean;
  generated: boolean;
  /** False for columns Postgres won't let an UPDATE set. */
  updatable: boolean;
  enums: string[];
};

export type RowTable = {
  schema: string;
  name: string;
  primary_keys: string[];
  /** Whether the user may save changes at all. */
  editable: boolean;
  columns: RowColumn[];
};

/** How a field is written: a typed value or an explicit NULL. */
export type FieldMode = 'value' | 'null';
export type FieldDraft = { raw: string; mode: FieldMode };
export type RowDraft = Record<string, FieldDraft>;

const JSON_FORMATS = ['json', 'jsonb'];
const INTEGER_FORMATS = ['int2', 'int4', 'int8'];
const DECIMAL_FORMATS = ['numeric', 'float4', 'float8'];

export const isJsonColumn = (column: RowColumn) =>
  JSON_FORMATS.includes(column.format);

export const isArrayColumn = (column: RowColumn) =>
  column.format.startsWith('_') || column.data_type === 'ARRAY';

/** Converts form text to the value written, or throws a message for the field. */
export function parseCellValue(
  column: RowColumn,
  raw: string,
  isNull: boolean
): unknown {
  if (isNull) {
    if (!column.nullable) throw new Error('This column does not allow NULL.');
    return null;
  }
  if (isJsonColumn(column)) return JSON.parse(raw);
  if (isArrayColumn(column)) {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error('Enter a JSON array.');
    return value;
  }
  if (column.format === 'bool') {
    if (raw !== 'true' && raw !== 'false') {
      throw new Error('Enter true or false.');
    }
    return raw === 'true';
  }
  if (INTEGER_FORMATS.includes(column.format) && !/^[+-]?\d+$/.test(raw)) {
    throw new Error('Enter a whole number.');
  }
  if (
    DECIMAL_FORMATS.includes(column.format) &&
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)
  ) {
    throw new Error('Enter a number.');
  }
  // Numbers stay strings so int8 and numeric values keep their precision.
  return raw;
}

/** The form text for a stored value: JSON shown indented for editing. */
function rawValue(column: RowColumn, value: unknown) {
  if (value == null) return '';
  if (isJsonColumn(column) || isArrayColumn(column)) {
    return JSON.stringify(value, null, 2);
  }
  return displayValue(value);
}

export function initialRowDraft(table: RowTable, row: Row): RowDraft {
  return Object.fromEntries(
    table.columns.map((column) => [
      column.name,
      {
        raw: rawValue(column, row[column.name]),
        mode: row[column.name] === null ? 'null' : 'value',
      },
    ])
  );
}

export const isFieldChanged = (a?: FieldDraft, b?: FieldDraft) =>
  a?.raw !== b?.raw || a?.mode !== b?.mode;

/** Updates never touch keys, identity or generated columns. */
export function canEditColumn(
  table: RowTable,
  column: RowColumn,
  isWritable: boolean
) {
  if (!isWritable || !column.updatable || column.generated) return false;
  return !column.identity && !table.primary_keys.includes(column.name);
}

/** A row can be written when the table allows it and the row has a complete primary key. */
export function isRowWritable(table: RowTable, readOnly: boolean, row: Row) {
  if (readOnly || !table.editable) return false;
  return (
    table.primary_keys.length > 0 &&
    table.primary_keys.every((key) => row[key] != null)
  );
}

/** The changed fields' values. Field errors name the column. */
export function buildRowValues(
  table: RowTable,
  draft: RowDraft,
  changedColumns: RowColumn[],
  isWritable: boolean
): Row {
  return Object.fromEntries(
    changedColumns
      .filter((column) => canEditColumn(table, column, isWritable))
      .map((column) => {
        const field = draft[column.name]!;
        try {
          return [
            column.name,
            parseCellValue(column, field.raw, field.mode === 'null'),
          ];
        } catch (error) {
          throw new Error(
            `${column.name}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })
  );
}

/** The complete primary key of a row. */
export const rowKey = (table: RowTable, row: Row): Row =>
  Object.fromEntries(table.primary_keys.map((key) => [key, row[key]]));
