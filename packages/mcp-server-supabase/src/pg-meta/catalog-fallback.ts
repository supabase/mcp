/**
 * TEMPORARY WORKAROUND. Delete this file and its two call sites in
 * `tools/database-operation-tools.ts` once the databases it serves run `tables.sql`, `columns.sql` and
 * `extensions.sql`.
 *
 * Used only after the pg-meta query fails. It reads the same facts with plain catalog queries and assembles
 * pg-meta's output shape in TypeScript, for databases whose `pg_catalog` is partial: today Spark on turso, which
 * lacks `unnest ... WITH ORDINALITY`, `DISTINCT ON`, the jsonb aggregates, `pg_enum`, `pg_stat_*` and
 * `pg_available_extensions()`. Row estimates and sizes read as 0, privilege filters are not applied, and enums and
 * comments are left empty when their catalogs are missing.
 */
import { SYSTEM_SCHEMAS } from './index.js';
import type {
  PostgresColumn,
  PostgresExtension,
  PostgresRelationship,
  PostgresTable,
} from './types.js';

export type CatalogQuery = (
  query: string,
  parameters?: unknown[]
) => Promise<Record<string, unknown>[]>;

const TABLES_SQL = `
select c.oid::int8 as id, n.nspname as schema, c.relname as name,
  c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')`;

const COLUMNS_SQL = `
select a.attrelid::int8 as table_id, a.attnum as ordinal_position, a.attname as name,
  a.attnotnull as not_null, a.attidentity as identity, a.attgenerated as generated,
  pg_get_expr(d.adbin, d.adrelid) as default_value,
  t.typname as type_name, t.typtype as type_type, t.typnotnull as type_not_null,
  t.typelem::int8 as type_elem, t.typlen as type_len, tn.nspname as type_schema,
  format_type(a.atttypid, null) as type_format,
  bt.typname as base_name, bt.typelem::int8 as base_elem, bt.typlen as base_len,
  bn.nspname as base_schema, format_type(t.typbasetype, null) as base_format,
  coalesce(bt.oid, t.oid)::int8 as enum_type, coalesce(bt.typelem, t.typelem)::int8 as enum_elem_type
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c on c.oid = a.attrelid
join pg_catalog.pg_type t on t.oid = a.atttypid
join pg_catalog.pg_namespace tn on tn.oid = t.typnamespace
left join pg_catalog.pg_type bt on t.typtype = 'd' and bt.oid = t.typbasetype
left join pg_catalog.pg_namespace bn on bn.oid = bt.typnamespace
left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped`;

const CONSTRAINTS_SQL = `
select co.oid::int8 as id, co.conname as name, co.contype as type,
  co.conrelid::int8 as table_id, co.confrelid::int8 as target_id,
  co.conkey::text as columns, co.confkey::text as target_columns,
  case when co.contype = 'c' then pg_get_expr(co.conbin, co.conrelid, true) end as definition
from pg_catalog.pg_constraint co
where co.contype in ('p', 'u', 'f', 'c') and co.conparentid = 0
order by co.oid`;

const ENUMS_SQL = `
select enumtypid::int8 as type_id, enumlabel as label
from pg_catalog.pg_enum
order by enumtypid, enumsortorder`;

const COMMENTS_SQL = `
select d.objoid::int8 as object_id, d.objsubid as column, d.description
from pg_catalog.pg_description d
where d.classoid = (
  select c.oid from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relname = 'pg_class' and n.nspname = 'pg_catalog'
)`;

const EXTENSIONS_SQL = `
select x.extname as name, n.nspname as schema, x.extversion as default_version,
  x.extversion as installed_version, null as comment
from pg_catalog.pg_extension x
left join pg_catalog.pg_namespace n on n.oid = x.extnamespace`;

// turso returns booleans as 0/1.
const bool = (value: unknown) =>
  value === true || value === 1 || value === 't' || value === 'true';
const int = (value: unknown) => Number(value ?? 0);
const text = (value: unknown) =>
  value === null || value === undefined ? null : String(value);

// Postgres prints an int2vector as `{1,2}`, turso as `1 2`.
const attnums = (value: unknown) =>
  value === null || value === undefined
    ? []
    : String(value)
        .replace(/[{}]/g, '')
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);

const optional = (run: Promise<Record<string, unknown>[]>) =>
  run.catch(() => [] as Record<string, unknown>[]);

function dataType(
  type: string | null,
  elem: number,
  len: number,
  schema: string | null,
  format: string | null
) {
  if (elem !== 0 && len === -1) return 'ARRAY';
  if (schema === 'pg_catalog') return format ?? type ?? 'USER-DEFINED';
  return 'USER-DEFINED';
}

/** Lists tables in pg-meta's shape with plain catalog queries. TEMPORARY: see the file comment. */
export async function listTablesFallback(
  query: CatalogQuery,
  schemas: string[] = []
): Promise<PostgresTable[]> {
  const [tables, columns, constraints, enums, comments] = await Promise.all([
    query(TABLES_SQL),
    query(COLUMNS_SQL),
    query(CONSTRAINTS_SQL),
    optional(query(ENUMS_SQL)),
    optional(query(COMMENTS_SQL)),
  ]);

  const wanted = (schema: string) =>
    schemas.length > 0
      ? schemas.includes(schema)
      : !SYSTEM_SCHEMAS.includes(schema);

  const tableById = new Map(
    tables.map((row) => [
      int(row.id),
      { schema: String(row.schema), name: String(row.name) },
    ])
  );
  const attname = new Map(
    columns.map((row) => [
      `${int(row.table_id)}.${int(row.ordinal_position)}`,
      String(row.name),
    ])
  );
  const labels = new Map<number, string[]>();
  for (const row of enums) {
    const id = int(row.type_id);
    labels.set(id, [...(labels.get(id) ?? []), String(row.label)]);
  }
  const comment = new Map(
    comments.map((row) => [
      `${int(row.object_id)}.${int(row.column)}`,
      text(row.description),
    ])
  );

  const unique = new Set<string>();
  const check = new Map<string, string | null>();
  const primaryKeys = new Map<number, number[]>();
  const relationships: PostgresRelationship[] = [];
  for (const row of constraints) {
    const tableId = int(row.table_id);
    const keys = attnums(row.columns);
    const type = String(row.type);
    if (type === 'p') primaryKeys.set(tableId, keys);
    if (type === 'u' && keys.length === 1) unique.add(`${tableId}.${keys[0]}`);
    // pg-meta keeps the first single-column check per column.
    if (
      type === 'c' &&
      keys.length === 1 &&
      !check.has(`${tableId}.${keys[0]}`)
    )
      check.set(`${tableId}.${keys[0]}`, text(row.definition));
    if (type === 'f') {
      const source = tableById.get(tableId);
      const targetId = int(row.target_id);
      const target = tableById.get(targetId);
      if (!source || !target) continue;
      relationships.push({
        id: int(row.id),
        constraint_name: String(row.name),
        source_schema: source.schema,
        source_table_name: source.name,
        source_columns: keys.map((n) => attname.get(`${tableId}.${n}`) ?? ''),
        target_table_schema: target.schema,
        target_table_name: target.name,
        target_columns: attnums(row.target_columns).map(
          (n) => attname.get(`${targetId}.${n}`) ?? ''
        ),
      });
    }
  }

  const columnsByTable = new Map<number, PostgresColumn[]>();
  for (const row of columns) {
    const tableId = int(row.table_id);
    const table = tableById.get(tableId);
    if (!table) continue;
    const position = int(row.ordinal_position);
    const key = `${tableId}.${position}`;
    const domain = row.type_type === 'd';
    const identity = text(row.identity);
    const enumLabels = [
      ...(labels.get(int(row.enum_type)) ?? []),
      ...(labels.get(int(row.enum_elem_type)) ?? []),
    ];
    const column: PostgresColumn = {
      table_id: tableId,
      schema: table.schema,
      table: table.name,
      id: key,
      ordinal_position: position,
      name: String(row.name),
      default_value: text(row.default_value),
      data_type: domain
        ? dataType(
            text(row.base_name),
            int(row.base_elem),
            int(row.base_len),
            text(row.base_schema),
            text(row.base_format)
          )
        : dataType(
            text(row.type_name),
            int(row.type_elem),
            int(row.type_len),
            text(row.type_schema),
            text(row.type_format)
          ),
      format: String(row.base_name ?? row.type_name),
      is_identity: identity === 'a' || identity === 'd',
      identity_generation:
        identity === 'a' ? 'ALWAYS' : identity === 'd' ? 'BY DEFAULT' : null,
      is_generated: text(row.generated) === 's',
      is_nullable: !(bool(row.not_null) || (domain && bool(row.type_not_null))),
      is_updatable: true,
      is_unique: unique.has(key),
      enums: enumLabels,
      check: check.get(key) ?? null,
      comment: comment.get(key) ?? null,
    };
    columnsByTable.set(tableId, [
      ...(columnsByTable.get(tableId) ?? []),
      column,
    ]);
  }

  return tables
    .filter((row) => wanted(String(row.schema)))
    .map((row) => {
      const id = int(row.id);
      const table = tableById.get(id)!;
      return {
        id,
        schema: table.schema,
        name: table.name,
        rls_enabled: bool(row.rls_enabled),
        rls_forced: bool(row.rls_forced),
        replica_identity: 'DEFAULT' as const,
        bytes: 0,
        size: '0 bytes',
        live_rows_estimate: 0,
        dead_rows_estimate: 0,
        comment: comment.get(`${id}.0`) ?? null,
        partition_of: null,
        columns: (columnsByTable.get(id) ?? []).sort(
          (a, b) => a.ordinal_position - b.ordinal_position
        ),
        primary_keys: (primaryKeys.get(id) ?? []).map((n) => ({
          schema: table.schema,
          table_name: table.name,
          name: attname.get(`${id}.${n}`) ?? '',
          table_id: id,
        })),
        relationships: relationships.filter(
          (r) =>
            (r.source_schema === table.schema &&
              r.source_table_name === table.name) ||
            (r.target_table_schema === table.schema &&
              r.target_table_name === table.name)
        ),
      };
    });
}

/** Lists installed extensions with `pg_extension` alone. TEMPORARY: see the file comment. */
export async function listExtensionsFallback(
  query: CatalogQuery
): Promise<PostgresExtension[]> {
  const rows = await query(EXTENSIONS_SQL);
  return rows.map((row) => ({
    name: String(row.name),
    schema: text(row.schema),
    default_version: String(row.default_version),
    installed_version: text(row.installed_version),
    comment: null,
  }));
}
