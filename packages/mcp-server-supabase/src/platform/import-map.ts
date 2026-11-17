/**
 * Import map file names detected in an Edge Function's root, in order of
 * precedence: `deno.json` before `deno.jsonc`, as the Supabase CLI does, then
 * the legacy `import_map.json`.
 */
export const DEFAULT_IMPORT_MAP_FILENAMES = [
  'deno.json',
  'deno.jsonc',
  'import_map.json',
] as const;

/**
 * Picks the import map to deploy with when none was given or previously set,
 * independent of the order the files were passed in.
 */
export function getDefaultImportMapPath(files: { name: string }[]) {
  return DEFAULT_IMPORT_MAP_FILENAMES.find((filename) =>
    files.some((file) => file.name === filename)
  );
}
