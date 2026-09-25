import { configDefaults, defineConfig } from 'vitest/config';
import { textLoaderPlugin } from './test/plugins/text-loader.js';

export default defineConfig({
  plugins: [textLoaderPlugin('.sql')],
  test: {
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000, // PGlite can take a while to initialize
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [...configDefaults.coverage.exclude!, 'src/cli.ts'],
    },
  },
});
