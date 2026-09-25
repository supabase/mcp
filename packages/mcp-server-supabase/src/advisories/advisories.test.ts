import { describe, expect, test } from 'vitest';
import { buildRlsDisabledAdvisory } from './rls-disabled.js';
import { type Advisory, selectAdvisory } from './schema.js';

describe('buildRlsDisabledAdvisory', () => {
  test('returns advisory when tables have RLS disabled', () => {
    const tables = [
      { schema: 'public', name: 'users', rls_enabled: false },
      { schema: 'public', name: 'posts', rls_enabled: true },
      { schema: 'public', name: 'comments', rls_enabled: false },
    ];

    const advisory = buildRlsDisabledAdvisory(tables);

    expect(advisory).not.toBeNull();
    expect(advisory!.id).toBe('rls_disabled');
    expect(advisory!.priority).toBe(1);
    expect(advisory!.level).toBe('critical');
    expect(advisory!.message).toContain('public.users');
    expect(advisory!.message).toContain('public.comments');
    expect(advisory!.message).not.toContain('public.posts');
    expect(advisory!.message).toContain('2 table(s)');
    expect(advisory!.remediation_sql).toBe(
      'ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;\n' +
        'ALTER TABLE "public"."comments" ENABLE ROW LEVEL SECURITY;'
    );
    expect(advisory!.doc_url).toContain('row-level-security');
  });

  test('returns null when all tables have RLS enabled', () => {
    const tables = [
      { schema: 'public', name: 'users', rls_enabled: true },
      { schema: 'public', name: 'posts', rls_enabled: true },
    ];

    expect(buildRlsDisabledAdvisory(tables)).toBeNull();
  });

  test('returns null for empty table list', () => {
    expect(buildRlsDisabledAdvisory([])).toBeNull();
  });

  test('ignores system schema tables with RLS disabled', () => {
    const tables = [
      { schema: 'auth', name: 'users', rls_enabled: false },
      { schema: 'storage', name: 'objects', rls_enabled: false },
      { schema: 'pg_catalog', name: 'pg_class', rls_enabled: false },
      { schema: 'extensions', name: 'http', rls_enabled: false },
      { schema: 'vault', name: 'secrets', rls_enabled: false },
    ];

    expect(buildRlsDisabledAdvisory(tables)).toBeNull();
  });

  test('only reports user-schema tables when mixed with system schemas', () => {
    const tables = [
      { schema: 'auth', name: 'users', rls_enabled: false },
      { schema: 'public', name: 'profiles', rls_enabled: false },
      { schema: 'storage', name: 'objects', rls_enabled: false },
    ];

    const advisory = buildRlsDisabledAdvisory(tables);

    expect(advisory).not.toBeNull();
    expect(advisory!.message).toContain('1 table(s)');
    expect(advisory!.message).toContain('public.profiles');
    expect(advisory!.message).not.toContain('auth.users');
    expect(advisory!.remediation_sql).toBe(
      'ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;'
    );
  });

  test('handles custom user schemas', () => {
    const tables = [
      { schema: 'myapp', name: 'orders', rls_enabled: false },
      { schema: 'api', name: 'products', rls_enabled: false },
    ];

    const advisory = buildRlsDisabledAdvisory(tables);

    expect(advisory).not.toBeNull();
    expect(advisory!.message).toContain('myapp.orders');
    expect(advisory!.message).toContain('api.products');
  });

  test('quotes identifiers containing special characters in remediation SQL', () => {
    const tables = [
      {
        schema: 'public',
        name: 'foo"; DROP TABLE bar; --',
        rls_enabled: false,
      },
    ];

    const advisory = buildRlsDisabledAdvisory(tables);

    expect(advisory).not.toBeNull();
    expect(advisory!.remediation_sql).toBe(
      'ALTER TABLE "public"."foo""; DROP TABLE bar; --" ENABLE ROW LEVEL SECURITY;'
    );
  });

  test('quotes a schema name containing a literal dot', () => {
    const tables = [{ schema: 'my.app', name: 'hobbies', rls_enabled: false }];

    const advisory = buildRlsDisabledAdvisory(tables);

    expect(advisory).not.toBeNull();
    expect(advisory!.remediation_sql).toBe(
      'ALTER TABLE "my.app"."hobbies" ENABLE ROW LEVEL SECURITY;'
    );
  });
});

describe('selectAdvisory', () => {
  const highPriority: Advisory = {
    id: 'rls_disabled',
    priority: 1,
    level: 'critical',
    title: 'RLS disabled',
    message: 'test',
    remediation_sql: 'test',
    doc_url: 'test',
  };

  const lowPriority: Advisory = {
    id: 'feature_discovery',
    priority: 4,
    level: 'info',
    title: 'Feature discovery',
    message: 'test',
    remediation_sql: 'test',
    doc_url: 'test',
  };

  test('returns null for empty candidates', () => {
    expect(selectAdvisory([])).toBeNull();
  });

  test('returns null when all candidates are null', () => {
    expect(selectAdvisory([null, null])).toBeNull();
  });

  test('returns the only non-null candidate', () => {
    expect(selectAdvisory([null, highPriority, null])).toBe(highPriority);
  });

  test('picks the highest priority (lowest number)', () => {
    expect(selectAdvisory([lowPriority, highPriority])).toBe(highPriority);
    expect(selectAdvisory([highPriority, lowPriority])).toBe(highPriority);
  });
});
