import { describe, expect, test } from 'vitest';
import {
  DEFAULT_IMPORT_MAP_FILENAMES,
  getDefaultImportMapPath,
} from './import-map.js';

const files = (...names: string[]) => names.map((name) => ({ name }));

describe('getDefaultImportMapPath', () => {
  test('prefers deno.json, then deno.jsonc, then import_map.json', () => {
    expect(DEFAULT_IMPORT_MAP_FILENAMES).toEqual([
      'deno.json',
      'deno.jsonc',
      'import_map.json',
    ]);
  });

  test.each([
    [['index.ts', 'deno.json'], 'deno.json'],
    [['index.ts', 'deno.jsonc'], 'deno.jsonc'],
    [['index.ts', 'import_map.json'], 'import_map.json'],
    [['index.ts', 'import_map.json', 'deno.jsonc', 'deno.json'], 'deno.json'],
    [['import_map.json', 'deno.jsonc', 'index.ts'], 'deno.jsonc'],
  ])('%j resolves to %s', (names, expected) => {
    expect(getDefaultImportMapPath(files(...names))).toBe(expected);
  });

  test('does not depend on file order', () => {
    const names = ['index.ts', 'import_map.json', 'deno.jsonc', 'deno.json'];
    expect(getDefaultImportMapPath(files(...names))).toBe(
      getDefaultImportMapPath(files(...[...names].reverse()))
    );
  });

  test('returns undefined when no import map file is present', () => {
    expect(getDefaultImportMapPath(files('index.ts', 'lib/util.ts'))).toBe(
      undefined
    );
  });

  test('only matches root-level file names', () => {
    expect(getDefaultImportMapPath(files('index.ts', 'src/deno.json'))).toBe(
      undefined
    );
  });
});
