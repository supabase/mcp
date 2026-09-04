import { describe, expect, test } from 'vitest';

import {
  checkDestructiveQuery,
  isDestructiveSql,
  isUpdateWithoutWhere,
} from './destructive-sql.js';

describe('checkDestructiveQuery', () => {
  test('drop statement matches', () => {
    expect(checkDestructiveQuery('drop table films, distributors;')).toBe(true);
  });

  test('truncate statement matches', () => {
    expect(checkDestructiveQuery('truncate films;')).toBe(true);
  });

  test('delete statement matches', () => {
    expect(
      checkDestructiveQuery("delete from films where kind <> 'Musical';")
    ).toBe(true);
  });

  test('delete statement after another statement matches', () => {
    expect(
      checkDestructiveQuery(`
        select * from films;
        delete from films where kind <> 'Musical';
      `)
    ).toBe(true);
  });

  test('RLS policy containing delete does not match', () => {
    expect(
      checkDestructiveQuery(`
        create policy "Users can delete their own files"
        on storage.objects for delete to authenticated using (
          bucket_id = 'files' and (select auth.uid()) = owner
        );
      `)
    ).toBe(false);
  });

  test('comment containing keywords does not match', () => {
    expect(
      checkDestructiveQuery(`
        -- Going to drop this in here, might delete later
        select * from films;
      `)
    ).toBe(false);
  });

  test('capitalized statement matches', () => {
    expect(
      checkDestructiveQuery("DELETE FROM films WHERE kind <> 'Musical';")
    ).toBe(true);
  });

  test('EXECUTE string containing DROP TABLE matches', () => {
    expect(checkDestructiveQuery("EXECUTE 'DROP TABLE films';")).toBe(true);
  });
});

describe('isUpdateWithoutWhere', () => {
  test('update with WHERE does not match', () => {
    expect(
      isUpdateWithoutWhere(
        "UPDATE public.countries SET name = 'New Name' WHERE id = 1;"
      )
    ).toBe(false);
  });

  test('update without WHERE matches', () => {
    expect(
      isUpdateWithoutWhere("UPDATE public.countries SET name = 'New Name';")
    ).toBe(true);
  });

  test('quoted identifier containing where without WHERE matches', () => {
    expect(isUpdateWithoutWhere('UPDATE "where table" SET id = 1;')).toBe(true);
  });

  test('string literal containing where without WHERE matches', () => {
    expect(isUpdateWithoutWhere("UPDATE films SET title = 'where now';")).toBe(
      true
    );
  });
});

describe('isDestructiveSql', () => {
  test('select statement does not match', () => {
    expect(isDestructiveSql('select * from films;')).toBe(false);
  });

  test('composite destructive query matches', () => {
    expect(
      isDestructiveSql('select * from films; UPDATE films SET title = null;')
    ).toBe(true);
  });
});
