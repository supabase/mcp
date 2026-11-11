import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { textLoaderPlugin } from './test/plugins/text-loader.js';

// Tests import a small stub instead of the built UI (`dist-ui/`), so they do
// not depend on `vite build` having run. The real bundle is covered by the
// build's size check and the end-to-end CLI check.
const htmlStub = fileURLToPath(
  new URL('./test/html-stub.html', import.meta.url)
);

export default defineConfig({
  plugins: [textLoaderPlugin('.html')],
  resolve: {
    alias: [
      {
        find: /^.*\/dist-ui\/api-gateway-report\.html$/,
        replacement: htmlStub,
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
