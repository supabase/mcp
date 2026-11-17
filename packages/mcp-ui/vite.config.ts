import { readdirSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * `vite build --app` builds each folder in `src/views/` into
 * `dist/src/views/<view>/index.html`. Each view is its own build environment, because
 * `vite-plugin-singlefile` only supports one entry per build.
 *
 * `vite` (dev) serves the mock host at `/dev/` and every view with HMR.
 */
const views = readdirSync('src/views');

// Environment names can't contain `-`.
const envName = (view: string) => view.replaceAll('-', '_');

export default defineConfig(({ command }) => ({
  plugins: [react(), ...(command === 'build' ? [viteSingleFile()] : [])],
  server: { open: '/dev/' },
  environments: Object.fromEntries(
    views.map((view) => [
      envName(view),
      {
        consumer: 'client',
        build: {
          // Shared by every view, so no environment may clear it.
          outDir: 'dist',
          emptyOutDir: false,
          rollupOptions: { input: `src/views/${view}/index.html` },
        },
      },
    ])
  ),
  builder: {
    buildApp: async (builder) => {
      for (const view of views) {
        await builder.build(builder.environments[envName(view)]!);
      }
    },
  },
}));
