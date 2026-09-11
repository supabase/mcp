import type { ParseResult } from 'libpg-query';
import * as parser from 'libpg-query';
import { describe, expect, test, vi } from 'vitest';

import { getSqlConfirmationReason } from './destructive-sql.js';

vi.mock('libpg-query', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof parser;
  return { ...actual, parse: vi.fn(actual.parse) };
});

describe('getSqlConfirmationReason', () => {
  test.each([
    'DROP TABLE films;',
    'DROP DATABASE films;',
    'DROP ROLE archivist;',
    'DROP OWNED BY archivist;',
    'DROP TABLESPACE archive;',
    'DROP USER MAPPING FOR archivist SERVER warehouse;',
    'DROP SUBSCRIPTION archive;',
    'DELETE FROM films WHERE id = 1;',
    'TRUNCATE films;',
  ])('classifies destructive statements: %s', async (sql) => {
    await expect(getSqlConfirmationReason(sql)).resolves.toBe('destructive');
  });

  test('classifies every statement in a batch without preprocessing quoted markers', async () => {
    await expect(
      getSqlConfirmationReason("SELECT '--';\nDROP TABLE films;")
    ).resolves.toBe('destructive');
  });

  test.each([
    'UPDATE films SET title = null;',
    'UPDATE films SET title = (SELECT title FROM archive WHERE id = 1);',
    "UPDATE films SET title = 'where now';",
  ])('classifies UPDATE using its own WHERE clause: %s', async (sql) => {
    await expect(getSqlConfirmationReason(sql)).resolves.toBe('destructive');
  });

  test.each([
    'UPDATE films SET title = null WHERE id = 1;',
    'UPDATE films SET title = null WHERE true;',
  ])('does not classify UPDATE with an outer WHERE: %s', async (sql) => {
    await expect(getSqlConfirmationReason(sql)).resolves.toBeUndefined();
  });

  test.each([
    'ALTER TABLE films DROP title;',
    'ALTER TABLE public.films DROP COLUMN IF EXISTS title CASCADE;',
    'ALTER TABLE ONLY "public"."film archive" DROP "display title";',
    'ALTER TABLE films ADD COLUMN rating int, DROP title;',
  ])('classifies TABLE column drops: %s', async (sql) => {
    await expect(getSqlConfirmationReason(sql)).resolves.toBe('destructive');
  });

  test.each([
    'ALTER TABLE films DROP CONSTRAINT films_pkey;',
    'ALTER TABLE films ALTER COLUMN title DROP DEFAULT;',
    'ALTER TABLE films ALTER COLUMN title DROP NOT NULL;',
    'ALTER TABLE films ALTER COLUMN id DROP IDENTITY;',
    'ALTER TABLE films ALTER COLUMN title DROP EXPRESSION;',
    'ALTER TYPE inventory_item DROP ATTRIBUTE supplier_id;',
  ])('leaves other ALTER actions outside the policy: %s', async (sql) => {
    await expect(getSqlConfirmationReason(sql)).resolves.toBeUndefined();
  });

  test.each([
    'WITH removed AS (DELETE FROM films RETURNING *) SELECT * FROM removed;',
    'WITH removed AS (DELETE FROM films RETURNING *) UPDATE films SET title = null WHERE id = 1;',
    'INSERT INTO archive WITH removed AS (DELETE FROM films RETURNING *) SELECT * FROM removed;',
  ])('classifies executing destructive CTEs: %s', async (sql) => {
    await expect(getSqlConfirmationReason(sql)).resolves.toBe('destructive');
  });

  test.each([
    'EXPLAIN (ANALYZE) DELETE FROM films;',
    'EXPLAIN (ANALYZE true) DELETE FROM films;',
    'EXPLAIN (ANALYZE ON) DELETE FROM films;',
    'EXPLAIN (ANALYZE 1) DELETE FROM films;',
    'EXPLAIN (ANALYZE false, ANALYZE true) DELETE FROM films;',
  ])('classifies executing EXPLAIN statements: %s', async (sql) => {
    await expect(getSqlConfirmationReason(sql)).resolves.toBe('destructive');
  });

  test.each([
    'EXPLAIN DELETE FROM films;',
    'EXPLAIN (ANALYZE false) DELETE FROM films;',
    'EXPLAIN (ANALYZE OFF) DELETE FROM films;',
    'EXPLAIN (ANALYZE 0) DELETE FROM films;',
    'EXPLAIN (ANALYZE true, ANALYZE false) DELETE FROM films;',
  ])('does not classify nonexecuting EXPLAIN statements: %s', async (sql) => {
    await expect(getSqlConfirmationReason(sql)).resolves.toBeUndefined();
  });

  test.each([
    "EXPLAIN (ANALYZE '1') DELETE FROM films;",
    'EXPLAIN (ANALYZE yes) DELETE FROM films;',
    'EXPLAIN (ANALYZE maybe, ANALYZE false) DELETE FROM films;',
    'EXPLAIN (ANALYZE 2) DELETE FROM films;',
  ])('does not silently accept invalid ANALYZE values: %s', async (sql) => {
    await expect(getSqlConfirmationReason(sql)).resolves.toBe('unclassified');
  });

  test.each([
    "DO $$ BEGIN EXECUTE 'DROP TABLE films'; END $$;",
    "DO $$ BEGIN EXECUTE format('DROP TABLE %I', 'films'); END $$;",
    "DO $$ BEGIN EXECUTE concat('DROP ', 'TABLE films'); END $$;",
    'DO $$ BEGIN PERFORM 1; DELETE FROM films; END $$;',
  ])(
    'uses the retained predicate only for extracted DO bodies: %s',
    async (sql) => {
      await expect(getSqlConfirmationReason(sql)).resolves.toBe('do-heuristic');
    }
  );

  test.each([
    'DO $$ BEGIN DELETE FROM films; END $$;',
    "DO $$ DECLARE command text := 'DROP TABLE films'; BEGIN EXECUTE command; END $$;",
    "DO $$ BEGIN RAISE NOTICE 'DELETE FROM films'; END $$;",
    "DO $$ BEGIN -- EXECUTE 'DROP TABLE films';\nRAISE NOTICE 'done'; END $$;",
    "CREATE FUNCTION remove_films() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'DROP TABLE films'; END $$;",
  ])(
    'preserves accepted DO gaps and stored-body exclusions: %s',
    async (sql) => {
      await expect(getSqlConfirmationReason(sql)).resolves.toBeUndefined();
    }
  );

  test.each([
    "SELECT 'DELETE FROM films';",
    'CREATE POLICY p ON films FOR DELETE USING (true);',
    '-- DROP TABLE films;\nSELECT 1;',
    'PREPARE remove_films AS DELETE FROM films;',
    '-- comment only',
  ])('does not traverse data or nonexecuting wrappers: %s', async (sql) => {
    await expect(getSqlConfirmationReason(sql)).resolves.toBeUndefined();
  });

  test.each(['', '   ', 'DELETE FROM'])(
    'classifies known-empty or malformed SQL as unknown: %s',
    async (sql) => {
      await expect(getSqlConfirmationReason(sql)).resolves.toBe('unclassified');
    }
  );

  test.each([
    [{}, 'SQL parser returned an invalid statement list.'],
    [
      { stmts: [{ stmt: undefined }] },
      'SQL parser returned an invalid statement.',
    ],
    [{ stmts: [{ stmt: [] }] }, 'SQL parser returned an invalid statement.'],
  ] as const)(
    'keeps malformed successful parser output terminal',
    async (result, message) => {
      vi.mocked(parser.parse).mockResolvedValueOnce(result as ParseResult);

      await expect(getSqlConfirmationReason('SELECT 1')).rejects.toThrow(
        message
      );
    }
  );
});
