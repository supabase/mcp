import { z } from 'zod/v4';
import { quoteIdentifier, SYSTEM_SCHEMAS } from '../advisories/rls-disabled.js';
import type { RlsFixTable } from './confirmation.js';
import { removeCommentsFromSql } from './destructive-sql.js';

/** `inputRequests` key for the post-execution RLS fix elicitation. */
export const RLS_FIX_REQUEST_KEY = 'rls_fix';

export const RLS_FIX_CHOICES = [
  'owner_only',
  'public_read_owner_write',
  'server_only',
  'leave_open',
] as const;

export type RlsFixChoice = (typeof RLS_FIX_CHOICES)[number];

const CHOICE_TITLES: Record<RlsFixChoice, string> = {
  owner_only: 'Owner-only',
  public_read_owner_write: 'Public read, owner writes',
  server_only: 'Server-only',
  leave_open: 'Leave open',
};

// Deliberately loose: a false positive costs two catalog queries, a false
// negative skips the check. Strings stay in, so dynamic DDL in DO blocks counts.
const exposingDdl =
  /\b(?:create|alter)\s+(?:[a-z_]+\s+){0,3}table\b|\bgrant\b|\bpolicy\b/i;

/**
 * Cheap text check for SQL that might leave a table exposed without RLS:
 * table DDL, policy DDL or grants. The RLS snapshot only runs when it passes.
 */
export function mayExposeTables(sql: string): boolean {
  return exposingDdl.test(removeCommentsFromSql(sql));
}

export const exposedTableSchema = z.object({
  id: z.number(),
  schema: z.string(),
  name: z.string(),
  owner_column: z.string().nullable(),
});

export type ExposedTable = z.infer<typeof exposedTableSchema>;

/**
 * Lists tables the Data API exposes without RLS, using the same rules as the
 * database linter's `rls_disabled_in_public`: regular tables in the schemas
 * from `pgrst.db_schemas` (default `public`), minus `SYSTEM_SCHEMAS`, that
 * `anon` or `authenticated` can select.
 *
 * `owner_column` is the first single-column uuid foreign key to
 * `auth.users(id)`, or `null` when the table has none.
 */
export function listExposedTablesSql() {
  const parameters = [...SYSTEM_SCHEMAS];
  const placeholders = parameters.map((_, i) => `$${i + 1}`).join(', ');
  const query = `
    with api_roles as (
      select rolname from pg_catalog.pg_roles
      where rolname in ('anon', 'authenticated')
    )
    select
      c.oid::int8 as id,
      n.nspname as schema,
      c.relname as name,
      (
        select a.attname
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_attribute a
          on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
        join pg_catalog.pg_attribute ra
          on ra.attrelid = con.confrelid and ra.attnum = con.confkey[1]
        where con.conrelid = c.oid
          and con.contype = 'f'
          and cardinality(con.conkey) = 1
          and con.confrelid = to_regclass('auth.users')
          and ra.attname = 'id'
          and a.atttypid = 'uuid'::regtype
        order by a.attnum
        limit 1
      ) as owner_column
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r'
      and not c.relrowsecurity
      and exists (
        select 1 from api_roles r
        where pg_catalog.has_table_privilege(r.rolname, c.oid, 'SELECT')
      )
      and n.nspname = any(array(
        select trim(unnest(string_to_array(
          coalesce(current_setting('pgrst.db_schemas', true), 'public'), ','
        )))
      ))
      and n.nspname not in (${placeholders})
    order by n.nspname, c.relname
  `;
  return { query, parameters };
}

/** Tables in `after` that `before` did not have, matched by oid. */
export function newlyExposedTables(
  before: ExposedTable[],
  after: ExposedTable[]
): RlsFixTable[] {
  const known = new Set(before.map((table) => table.id));
  return after
    .filter((table) => !known.has(table.id))
    .map(({ schema, name, owner_column }) => ({ schema, name, owner_column }));
}

/** The owner options need an owner column on every table, since one choice covers them all. */
export function offeredRlsFixChoices(tables: RlsFixTable[]): RlsFixChoice[] {
  return tables.every((table) => table.owner_column !== null)
    ? [...RLS_FIX_CHOICES]
    : ['server_only', 'leave_open'];
}

export function formatTable({ schema, name }: RlsFixTable): string {
  return `${schema}.${name}`;
}

export function rlsFixMessage(tables: RlsFixTable[]): string {
  const offered = offeredRlsFixChoices(tables);
  const listed = tables
    .map((table) =>
      table.owner_column === null
        ? formatTable(table)
        : `${formatTable(table)} (owner column: ${table.owner_column})`
    )
    .join(', ');
  const explanations: Record<RlsFixChoice, string> = {
    owner_only:
      'Owner-only: signed-in users can read and change only the rows they own.',
    public_read_owner_write:
      'Public read, owner writes: anyone can read. Only the owner can insert, update or delete.',
    server_only:
      'Server-only: enable RLS with no policies. Only the service role can reach the table.',
    leave_open: 'Leave open: change nothing.',
  };
  return [
    `The SQL ran and left ${tables.length} table(s) without Row Level Security: ${listed}.`,
    "Anyone with the project's anon key can read and change every row.",
    'How should they be protected?',
    ...offered.map((choice) => `- ${explanations[choice]}`),
  ].join('\n');
}

export function rlsFixElicitationSchema(tables: RlsFixTable[]) {
  return {
    type: 'object' as const,
    properties: {
      choice: {
        type: 'string' as const,
        title: 'Protection',
        oneOf: offeredRlsFixChoices(tables).map((choice) => ({
          const: choice,
          title: CHOICE_TITLES[choice],
        })),
      },
    },
    required: ['choice'],
  };
}

/** Accepted content must name one of the choices offered for these tables. */
export function rlsFixContentSchema(tables: RlsFixTable[]) {
  const offered = offeredRlsFixChoices(tables);
  return z.object({
    choice: z
      .enum(RLS_FIX_CHOICES)
      .refine((choice) => offered.includes(choice)),
  });
}

/** SQL for one choice across all tables. Callers only pass offered choices. */
export function buildRlsFixSql(
  choice: Exclude<RlsFixChoice, 'leave_open'>,
  tables: RlsFixTable[]
): string {
  return tables
    .flatMap((table) => {
      const target = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
      const statements = [`alter table ${target} enable row level security;`];
      if (choice === 'server_only') {
        return statements;
      }
      if (table.owner_column === null) {
        throw new Error(`${formatTable(table)} has no owner column.`);
      }

      const isOwner = `(select auth.uid()) = ${quoteIdentifier(table.owner_column)}`;
      const policy = (name: string, rest: string) =>
        `create policy ${quoteIdentifier(name)} on ${target} ${rest};`;
      statements.push(
        choice === 'owner_only'
          ? policy(
              'Owners can read their rows',
              `for select to authenticated using (${isOwner})`
            )
          : policy(
              'Anyone can read rows',
              'for select to anon, authenticated using (true)'
            ),
        policy(
          'Owners can insert their rows',
          `for insert to authenticated with check (${isOwner})`
        ),
        policy(
          'Owners can update their rows',
          `for update to authenticated using (${isOwner}) with check (${isOwner})`
        ),
        policy(
          'Owners can delete their rows',
          `for delete to authenticated using (${isOwner})`
        )
      );
      return statements;
    })
    .join('\n');
}
