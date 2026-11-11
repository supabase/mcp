import { readFile } from 'node:fs/promises';

// Mirrors packages/mcp-server-supabase/test/plugins/text-loader.ts, without a
// `vite` type import (the UI toolchain's vite differs from vitest's).
export function textLoaderPlugin(extension: string) {
  return {
    name: 'text-loader',
    async transform(code: string, id: string) {
      if (id.endsWith(extension)) {
        const textContent = await readFile(id, 'utf8');
        return `export default ${JSON.stringify(textContent)};`;
      }
      return code;
    },
  };
}
