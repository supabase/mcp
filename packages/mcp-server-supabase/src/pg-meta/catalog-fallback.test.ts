import { PGlite } from '@electric-sql/pglite';
import { describe, expect, test } from 'vitest';
import {
  type CatalogQuery,
  listExtensionsFallback,
  listTablesFallback,
} from './catalog-fallback.js';
import { listExtensionsSql, listTablesSql } from './index.js';
import { postgresExtensionSchema, postgresTableSchema } from './types.js';

const SCHEMA = `
create schema other;
create table other.owners (id int primary key, handle text);
create type public.mood as enum ('happy', 'sad');
create domain public.positive as int check (value > 0) not null;
create table public.authors (
  id bigint generated always as identity primary key,
  email text not null unique,
  mood public.mood default 'happy',
  moods public.mood[],
  age int check (age > 0),
  score public.positive,
  tags text[],
  note varchar(20),
  full_name text generated always as (email || '!') stored,
  owner_id int references other.owners (id)
);
create table public.pairs (a int, b int, author_id bigint, primary key (b, a),
  constraint pairs_author foreign key (author_id) references public.authors (id));
comment on table public.authors is 'people who write';
comment on column public.authors.email is 'login';
alter table public.pairs enable row level security;
`;

// Fields the fallback cannot read on a partial catalog; see the comment in catalog-fallback.ts.
const comparable = (tables: unknown[]) =>
  tables
    .map((table) => postgresTableSchema.parse(table))
    .map(
      ({
        bytes,
        size,
        live_rows_estimate,
        dead_rows_estimate,
        replica_identity,
        relationships,
        ...table
      }) => ({
        ...table,
        relationships: [...relationships].sort((a, b) => a.id - b.id),
      })
    )
    .sort((a, b) => a.id - b.id);

async function database() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  const query: CatalogQuery = async (sql, parameters) =>
    (await db.query<Record<string, unknown>>(sql, parameters)).rows;
  return query;
}

describe('catalog fallback (temporary workaround)', () => {
  test.each([[[]], [['public']], [['other', 'public']]])(
    'lists tables like the pg-meta query on Postgres for schemas %j',
    async (schemas) => {
      const query = await database();
      const { query: sql, parameters } = listTablesSql(schemas);

      const expected = comparable(await query(sql, parameters));
      const actual = comparable(await listTablesFallback(query, schemas));

      expect(expected.length).toBeGreaterThan(0);
      expect(actual).toEqual(expected);
    }
  );

  test('lists installed extensions like the pg-meta query', async () => {
    const query = await database();
    const installed = (await query(listExtensionsSql()))
      .map((row) => postgresExtensionSchema.parse(row))
      .filter((extension) => extension.installed_version !== null)
      .map(({ default_version, comment, ...extension }) => extension);

    const actual = (await listExtensionsFallback(query)).map(
      ({ default_version, comment, ...extension }) => extension
    );

    expect(actual).toEqual(installed);
  });
});
