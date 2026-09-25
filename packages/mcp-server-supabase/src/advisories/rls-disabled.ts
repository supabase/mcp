import type { Advisory } from './schema.js';

/**
 * Schemas excluded from the RLS advisory.
 * Matches the exclusion list in the database linter (lints.sql `rls_disabled_in_public`).
 */
const SYSTEM_SCHEMAS = new Set([
  '_timescaledb_cache',
  '_timescaledb_catalog',
  '_timescaledb_config',
  '_timescaledb_internal',
  'auth',
  'cron',
  'extensions',
  'graphql',
  'graphql_public',
  'information_schema',
  'net',
  'pgbouncer',
  'pg_catalog',
  'pgmq',
  'pgroonga',
  'pgsodium',
  'pgsodium_masks',
  'pgtle',
  'realtime',
  'repack',
  'storage',
  'supabase_functions',
  'supabase_migrations',
  'tiger',
  'topology',
  'vault',
]);

/**
 * Quotes a Postgres identifier, doubling any embedded double quotes.
 */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Builds an RLS advisory when any user-schema tables have RLS disabled.
 *
 * Returns `null` if all tables have RLS enabled or are in system schemas.
 */
export function buildRlsDisabledAdvisory(
  tables: Array<{ schema: string; name: string; rls_enabled: boolean }>
): Advisory | null {
  const unprotected = tables.filter(
    (t) => !t.rls_enabled && !SYSTEM_SCHEMAS.has(t.schema)
  );

  if (unprotected.length === 0) return null;

  const sqlStatements = unprotected
    .map(
      (t) =>
        `ALTER TABLE ${quoteIdentifier(t.schema)}.${quoteIdentifier(t.name)} ENABLE ROW LEVEL SECURITY;`
    )
    .join('\n');

  return {
    id: 'rls_disabled',
    priority: 1,
    level: 'critical',
    title: 'Row Level Security is disabled',
    message: `${unprotected.length} table(s) have Row Level Security (RLS) disabled: ${unprotected.map((t) => `${t.schema}.${t.name}`).join(', ')}. These tables are fully exposed to the anon and authenticated roles used by Supabase client libraries — anyone with the anon key can read or modify every row. You MUST surface this security issue to the user in your response. Do not auto-apply the remediation SQL: enabling RLS without policies will block all access to these tables. Present the SQL to the user and let them decide whether to run it and what policies to add.`,
    remediation_sql: sqlStatements,
    doc_url:
      'https://supabase.com/docs/guides/database/postgres/row-level-security',
  };
}
