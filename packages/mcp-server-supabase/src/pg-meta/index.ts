import { stripIndent } from 'common-tags';
import extensionsSql from './extensions.sql';

export const SYSTEM_SCHEMAS = [
  'information_schema',
  'pg_catalog',
  'pg_toast',
  '_timescaledb_internal',
];

/**
 * Builds a parameterized filter that matches when any of the given schema
 * columns is in `schemas`, or outside the system schemas when `schemas` is
 * empty.
 */
function schemaFilter(columns: string[], schemas: string[]) {
  const [operator, parameters] =
    schemas.length > 0
      ? (['in', schemas] as const)
      : (['not in', SYSTEM_SCHEMAS] as const);
  const placeholders = parameters.map((_, i) => `$${i + 1}`).join(', ');
  const clause = columns
    .map((column) => `${column} ${operator} (${placeholders})`)
    .join(' or ');

  return { clause: `(${clause})`, parameters: [...parameters] };
}

/**
 * Generates the SQL query to list tables in the database.
 */
export function listTablesSql(schemas: string[] = []) {
  const filter = schemaFilter(['table_schema'], schemas);

  return {
    query: stripIndent`
      select
        table_schema as schema,
        table_name as name
      from information_schema.tables
      where table_type = 'BASE TABLE'
        and ${filter.clause}
      order by table_schema, table_name
    `,
    parameters: filter.parameters,
  };
}

/**
 * Generates the SQL query to list the columns of tables in the database.
 */
export function listColumnsSql(schemas: string[] = []) {
  const filter = schemaFilter(['table_schema'], schemas);

  return {
    query: stripIndent`
      select
        table_schema as schema,
        table_name as table,
        column_name as name,
        column_default as default_value,
        data_type,
        udt_name as format,
        is_identity,
        identity_generation,
        is_generated,
        is_nullable,
        is_updatable
      from information_schema.columns
      where ${filter.clause}
      order by table_schema, table_name, ordinal_position
    `,
    parameters: filter.parameters,
  };
}

/**
 * Generates the SQL query to list primary key, unique, and foreign key
 * columns, one row per constrained column.
 *
 * Foreign key rows carry the referenced column at the same key position, and
 * match when either side is in scope so the referenced table sees them too.
 */
export function listKeyColumnsSql(schemas: string[] = []) {
  const filter = schemaFilter(
    ['kcu.table_schema', 'ref.table_schema'],
    schemas
  );

  return {
    query: stripIndent`
      select
        tc.constraint_type,
        tc.constraint_name,
        kcu.table_schema as schema,
        kcu.table_name as table,
        kcu.column_name as name,
        kcu.ordinal_position,
        ref.table_schema as target_schema,
        ref.table_name as target_table,
        ref.column_name as target_name
      from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_schema = tc.constraint_schema
          and kcu.constraint_name = tc.constraint_name
          and kcu.table_schema = tc.table_schema
          and kcu.table_name = tc.table_name
        left join information_schema.referential_constraints rc
          on rc.constraint_schema = tc.constraint_schema
          and rc.constraint_name = tc.constraint_name
        left join information_schema.key_column_usage ref
          on ref.constraint_schema = rc.unique_constraint_schema
          and ref.constraint_name = rc.unique_constraint_name
          and ref.ordinal_position = kcu.position_in_unique_constraint
      where tc.constraint_type in ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
        and ${filter.clause}
      order by
        kcu.table_schema,
        kcu.table_name,
        tc.constraint_name,
        kcu.ordinal_position
    `,
    parameters: filter.parameters,
  };
}

/**
 * Generates the SQL query to list all extensions in the database.
 */
export function listExtensionsSql() {
  return extensionsSql;
}
