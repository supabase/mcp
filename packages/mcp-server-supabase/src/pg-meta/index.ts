import { stripIndent } from 'common-tags';
import columnsSql from './columns.sql';
import extensionsSql from './extensions.sql';
import tablesSql from './tables.sql';

export const SYSTEM_SCHEMAS = [
  'information_schema',
  'pg_catalog',
  'pg_toast',
  '_timescaledb_internal',
];

/**
 * Generates the SQL query to list tables in the database.
 */
export function listTablesSql(schemas: string[] = []) {
  let sql = stripIndent`
    with
      tables as (${tablesSql}),
      columns as (${columnsSql})
    select
      *,
      ${coalesceRowsToArray(
        'columns',
        'columns.table_id = tables.id',
        'columns.ordinal_position'
      )}
    from tables
  `;

  sql += '\n';
  let parameters: any[] = [];

  if (schemas.length > 0) {
    const placeholders = schemas.map((_, i) => `$${i + 1}`).join(', ');
    sql += `where schema in (${placeholders})`;
    parameters = schemas;
  } else {
    const placeholders = SYSTEM_SCHEMAS.map((_, i) => `$${i + 1}`).join(', ');
    sql += `where schema not in (${placeholders})`;
    parameters = SYSTEM_SCHEMAS;
  }

  return { query: sql, parameters };
}

/**
 * Generates the SQL query to list all extensions in the database.
 */
export function listExtensionsSql() {
  return extensionsSql;
}

/**
 * Generates a SQL segment that coalesces rows into an array of JSON objects.
 */
export const coalesceRowsToArray = (
  source: string,
  filter: string,
  orderBy?: string
) => {
  const order = orderBy ? ` ORDER BY ${orderBy}` : '';
  return stripIndent`
    COALESCE(
      (
        SELECT
          array_agg(row_to_json(${source})${order}) FILTER (WHERE ${filter})
        FROM
          ${source}
      ),
      '{}'
    ) AS ${source}
  `;
};
