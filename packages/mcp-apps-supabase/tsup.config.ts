import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    outDir: 'dist',
    sourcemap: true,
    dts: true,
    minify: true,
    splitting: true,
    loader: {
      // The single-file UI built by `vite build` is embedded as a string.
      '.html': 'text',
    },
  },
]);
