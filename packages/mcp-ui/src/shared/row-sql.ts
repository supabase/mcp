/**
 * SQL for reading and saving one row through `execute_sql`, which takes no
 * parameters, so values go in as quoted literals. Every literal is a quoted
 * string Postgres casts to the column's type (or NULL), and every name is a
 * quoted identifier, so no value or name can end the statement.
 */
import {
  isArrayColumn,
  isJsonColumn,
  type RowColumn,
  type RowTable,
} from './row-values';
import type { Row } from './sql-result';

export const quoteIdentifier = (name: string) =>
  `"${name.replaceAll('"', '""')}"`;

/**
 * An escape-string literal (`E'…'`): backslashes and quotes are escaped, so it
 * reads the same whatever the database's standard_conforming_strings is.
 */
export const quoteLiteral = (text: string) =>
  `E'${text.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;

/** A Postgres array literal (`{"a","b"}`) for a JSON array, nested arrays included. */
function arrayLiteral(items: unknown[]): string {
  const element = (item: unknown): string => {
    if (item === null) return 'NULL';
    if (Array.isArray(item)) return arrayLiteral(item);
    const text = typeof item === 'object' ? JSON.stringify(item) : String(item);
    return `"${text.replace(/["\\]/g, '\\$&')}"`;
  };
  return `{${items.map(element).join(',')}}`;
}

/** A value as SQL for `column`. */
export function sqlValue(column: RowColumn | undefined, value: unknown) {
  if (value === null || value === undefined) return 'NULL';
  if (column && isArrayColumn(column) && Array.isArray(value)) {
    return quoteLiteral(arrayLiteral(value));
  }
  if ((column && isJsonColumn(column)) || typeof value === 'object') {
    return quoteLiteral(JSON.stringify(value));
  }
  return quoteLiteral(String(value));
}

const relation = (table: RowTable) =>
  `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;

function whereKey(table: RowTable, key: Row) {
  const column = (name: string) =>
    table.columns.find((item) => item.name === name);
  return table.primary_keys
    .map(
      (name) =>
        `${quoteIdentifier(name)} = ${sqlValue(column(name), key[name])}`
    )
    .join(' and ');
}

/** Reads the row with `key` again. */
export function selectRowSql(table: RowTable, key: Row) {
  return `select * from ${relation(table)} where ${whereKey(table, key)} limit 1;`;
}

/** Saves `values` to the row with `key` and returns it as stored. */
export function updateRowSql(table: RowTable, key: Row, values: Row) {
  const column = (name: string) =>
    table.columns.find((item) => item.name === name);
  const set = Object.entries(values)
    .map(
      ([name, value]) =>
        `${quoteIdentifier(name)} = ${sqlValue(column(name), value)}`
    )
    .join(', ');
  return `update ${relation(table)} set ${set} where ${whereKey(table, key)} returning *;`;
}
